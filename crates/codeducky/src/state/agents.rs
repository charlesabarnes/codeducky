//! The agents panel's state: the repo's terminals from herdr-core, which one is on screen, and
//! the hand-offs in flight. Blocking calls run on the background executor; directory events
//! arrive on a channel and are applied here.

use std::collections::HashMap;

use ducky_agents::{
    AgentDirectory, AgentInfo, Delivery, DirectoryEvent, Started, Task, TaskProgress,
};
use ducky_hc::TemplateInfo;
use ducky_session::agents::{
    AgentRequest, AgentsService, DeliveryOutcome, OutcomeLevel, describe_delivery,
    describe_progress,
};
use ducky_session::{Connection, Review};
use gpui_kit::*;

/// Where the panel stands with herdr-core.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Line {
    NoReview,
    /// Local only: agents need herdr-core.
    NeedsCore {
        reason: String,
    },
    Connecting,
    Ready,
    Disconnected {
        reason: String,
    },
    Failed(String),
}

/// What the tab strip shows beside an agent besides its record.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Marks {
    pub bell: bool,
    /// The last hand-off's state: `fix…`, `fix: done`.
    pub task: Option<String>,
}

/// A hand-off that was refused because the agent is blocked, kept to send anyway.
#[derive(Debug, Clone, PartialEq)]
pub struct Retry {
    pub address: String,
    pub task: Task,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Toast {
    pub text: String,
    pub level: OutcomeLevel,
    pub retry: Option<Retry>,
}

pub enum AgentsEvent {
    /// An agent finished a turn or a task: the notes may have changed.
    ReloadNotes,
    Toast(Toast),
    /// Show this terminal (attach), or none.
    Show(Option<String>),
}

impl EventEmitter<AgentsEvent> for AgentsModel {}

/// Which review and connection the directory follows.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Key {
    connection: u64,
    machine: Option<String>,
    root: String,
}

pub struct AgentsModel {
    pub line: Line,
    pub agents: Vec<AgentInfo>,
    pub selected: Option<String>,
    pub marks: HashMap<String, Marks>,
    /// Addresses handed work or shown, newest first.
    pub recent: Vec<String>,
    pub templates: Vec<TemplateInfo>,
    pub busy: Option<String>,
    service: Option<AgentsService>,
    directory: Option<AgentDirectory>,
    key: Option<Key>,
    generation: u64,
}

type Work<T> = Box<dyn FnOnce() -> Result<T, String> + Send>;

impl AgentsModel {
    pub fn new() -> Self {
        Self {
            line: Line::NoReview,
            agents: Vec::new(),
            selected: None,
            marks: HashMap::new(),
            recent: Vec::new(),
            templates: Vec::new(),
            busy: None,
            service: None,
            directory: None,
            key: None,
            generation: 0,
        }
    }

    pub fn service(&self) -> Option<&AgentsService> {
        self.service.as_ref()
    }

    pub fn machine(&self) -> Option<&str> {
        self.service.as_ref().and_then(AgentsService::machine)
    }

    pub fn agent(&self, address: &str) -> Option<&AgentInfo> {
        self.agents.iter().find(|a| a.address == address)
    }

    /// The name people know an agent by.
    pub fn label(&self, address: &str) -> String {
        self.agent(address)
            .and_then(|a| a.name.clone())
            .unwrap_or_else(|| address.to_owned())
    }

    fn run<T: Send + 'static>(
        &mut self,
        label: impl Into<String>,
        cx: &mut Context<Self>,
        work: Work<T>,
        done: impl FnOnce(&mut Self, Result<T, String>, &mut Context<Self>) + 'static,
    ) {
        self.busy = Some(label.into());
        cx.notify();
        let generation = self.generation;
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { work() }).await;
            this.update(cx, |this, cx| {
                this.busy = None;
                if this.generation == generation {
                    done(this, result, cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn reset(&mut self, line: Line, cx: &mut Context<Self>) {
        self.generation += 1;
        self.line = line;
        self.service = None;
        self.directory = None;
        self.agents.clear();
        self.templates.clear();
        self.marks.clear();
        self.busy = None;
        if self.selected.take().is_some() {
            cx.emit(AgentsEvent::Show(None));
        }
        cx.notify();
    }

    /// Follows the open review: subscribes for its repo's terminals on its machine. Nothing is
    /// attached until someone picks a terminal.
    pub fn follow(
        &mut self,
        connection: Option<&Connection>,
        connection_generation: u64,
        review: Option<&Review>,
        cx: &mut Context<Self>,
    ) {
        let (Some(connection), Some(review)) = (connection, review) else {
            self.key = None;
            self.reset(Line::NoReview, cx);
            return;
        };
        let key = Key {
            connection: connection_generation,
            machine: review.request.machine.clone(),
            root: review.toplevel().to_owned(),
        };
        let settled = matches!(self.line, Line::Ready | Line::Connecting);
        if self.key.as_ref() == Some(&key) && settled {
            return;
        }
        self.key = Some(key);
        if let ducky_session::ConnectionState::LocalOnly { reason } = connection.state() {
            self.reset(
                Line::NeedsCore {
                    reason: reason.clone(),
                },
                cx,
            );
            return;
        }
        self.reset(Line::Connecting, cx);
        let (connection, review) = (connection.clone(), review.clone());
        self.run(
            "looking for agents",
            cx,
            Box::new(move || {
                let service =
                    AgentsService::for_review(&connection, &review).map_err(|e| e.to_string())?;
                let (directory, events) = service.directory().map_err(|e| e.to_string())?;
                let templates = service.templates().unwrap_or_default();
                Ok((service, directory, events, templates))
            }),
            |this, result, cx| match result {
                Ok((service, directory, events, templates)) => {
                    this.agents = directory.agents();
                    this.service = Some(service);
                    this.directory = Some(directory);
                    this.templates = templates;
                    this.line = Line::Ready;
                    this.pump(events, cx);
                }
                Err(error) => this.line = Line::Failed(error),
            },
        );
    }

    fn pump(&mut self, events: flume::Receiver<DirectoryEvent>, cx: &mut Context<Self>) {
        let generation = self.generation;
        cx.spawn(async move |this, cx| {
            while let Ok(event) = events.recv_async().await {
                let current = this.update(cx, |this, cx| {
                    if this.generation != generation {
                        return false;
                    }
                    this.apply(event, cx);
                    true
                });
                if !matches!(current, Ok(true)) {
                    return;
                }
            }
        })
        .detach();
    }

    fn apply(&mut self, event: DirectoryEvent, cx: &mut Context<Self>) {
        match event {
            DirectoryEvent::Changed { .. } => {
                if let Some(directory) = &self.directory {
                    self.agents = directory.agents();
                }
                if self.line != Line::Ready
                    && self
                        .directory
                        .as_ref()
                        .is_some_and(|d| d.connection() == ducky_agents::Connection::Connected)
                {
                    self.line = Line::Ready;
                }
            }
            DirectoryEvent::TurnEnded { .. } => cx.emit(AgentsEvent::ReloadNotes),
            DirectoryEvent::Task { ticket, progress } => {
                let finished = matches!(progress, TaskProgress::Finished(_));
                self.marks.entry(ticket.address.clone()).or_default().task =
                    Some(describe_progress(ticket.kind, Some(&progress)));
                if progress == TaskProgress::Blocked {
                    self.toast(
                        OutcomeLevel::Warning,
                        format!(
                            "{} needs you before it can go on with the {} task",
                            self.label(&ticket.address),
                            ticket.kind.as_str()
                        ),
                        cx,
                    );
                }
                if finished {
                    cx.emit(AgentsEvent::ReloadNotes);
                }
            }
            DirectoryEvent::Disconnected { reason } => {
                self.line = Line::Disconnected { reason };
            }
        }
        cx.notify();
    }

    fn toast(&mut self, level: OutcomeLevel, text: String, cx: &mut Context<Self>) {
        cx.emit(AgentsEvent::Toast(Toast {
            text,
            level,
            retry: None,
        }));
    }

    fn used(&mut self, address: &str) {
        self.recent.retain(|a| a != address);
        self.recent.insert(0, address.to_owned());
    }

    /// Shows (attaches to) a terminal. Only on a person's pick, or for one this app started.
    pub fn select(&mut self, address: Option<String>, cx: &mut Context<Self>) {
        if let Some(address) = &address {
            self.used(address);
            self.marks.entry(address.clone()).or_default().bell = false;
        }
        if self.selected != address {
            self.selected = address.clone();
            cx.emit(AgentsEvent::Show(address));
        }
        cx.notify();
    }

    pub fn ring(&mut self, address: &str, cx: &mut Context<Self>) {
        self.marks.entry(address.to_owned()).or_default().bell = true;
        cx.notify();
    }

    pub fn start(&mut self, request: AgentRequest, cx: &mut Context<Self>) {
        let Some(service) = self.service.clone() else {
            return;
        };
        let label = format!("starting {}", request.name);
        self.run(
            label,
            cx,
            Box::new(move || service.start(&request).map_err(|e| e.to_string())),
            |this, result, cx| match result {
                Ok(started) => this.started(started, cx),
                Err(error) => this.toast(
                    OutcomeLevel::Error,
                    format!("Could not start the agent: {error}"),
                    cx,
                ),
            },
        );
    }

    fn started(&mut self, started: Started, cx: &mut Context<Self>) {
        let address = started.terminal.address.clone();
        if let Some(directory) = &self.directory {
            self.agents = directory.agents();
        }
        let name = started
            .terminal
            .name
            .clone()
            .unwrap_or_else(|| address.clone());
        match &started.first_task {
            Some(delivery) => self.delivered(&address, &name, None, delivery, cx),
            None => self.toast(OutcomeLevel::Success, format!("Started {name}"), cx),
        }
        self.select(Some(address), cx);
    }

    /// Types the task into a running agent; `force` only after a refusal the person saw.
    pub fn send(&mut self, address: String, task: Task, force: bool, cx: &mut Context<Self>) {
        let Some(service) = self.service.clone() else {
            return;
        };
        let name = self.label(&address);
        self.used(&address);
        let label = format!("sending a {} task to {name}", task.kind().as_str());
        let sent = (address.clone(), task.clone());
        self.run(
            label,
            cx,
            Box::new(move || Ok(service.send(&address, &task, force))),
            move |this, result: Result<Delivery, String>, cx| {
                let (address, task) = sent;
                if let Ok(delivery) = result {
                    this.delivered(&address, &name, Some(task), &delivery, cx);
                }
            },
        );
    }

    fn delivered(
        &mut self,
        address: &str,
        name: &str,
        task: Option<Task>,
        delivery: &Delivery,
        cx: &mut Context<Self>,
    ) {
        let DeliveryOutcome {
            text,
            level,
            offer_force,
        } = describe_delivery(delivery, name);
        if let Some(ticket) = delivery.ticket() {
            self.marks.entry(address.to_owned()).or_default().task =
                Some(describe_progress(ticket.kind, None));
            if let Some(directory) = &self.directory {
                directory.track(ticket.clone());
            }
        }
        let retry = task.filter(|_| offer_force).map(|task| Retry {
            address: address.to_owned(),
            task,
        });
        cx.emit(AgentsEvent::Toast(Toast { text, level, retry }));
        cx.notify();
    }

    /// Forgets a finished terminal in the core's list.
    pub fn remove(&mut self, address: String, cx: &mut Context<Self>) {
        let Some(service) = self.service.clone() else {
            return;
        };
        let target = address.clone();
        self.run(
            format!("removing {address}"),
            cx,
            Box::new(move || service.remove(&target).map_err(|e| e.to_string())),
            move |this, result, cx| match result {
                Ok(()) => {
                    if this.selected.as_deref() == Some(address.as_str()) {
                        this.select(None, cx);
                    }
                    this.recent.retain(|a| *a != address);
                    this.marks.remove(&address);
                }
                Err(error) => this.toast(
                    OutcomeLevel::Error,
                    format!("Could not remove it: {error}"),
                    cx,
                ),
            },
        );
    }

    #[cfg(feature = "screenshot")]
    pub fn is_ready(&self) -> bool {
        self.busy.is_none()
    }
}
