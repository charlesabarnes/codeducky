//! [`AgentDirectory`]: a live, thread-safe list of the terminals working in one repo, from
//! `events.subscribe` (a snapshot, then every change) on a background thread.
//!
//! Nothing reconnects by itself: when the core connection drops, the directory says so
//! ([`Connection::Disconnected`] and [`DirectoryEvent::Disconnected`]) and keeps its last list
//! until the caller hands it a new client with [`AgentDirectory::reconnect`].

mod agent;
mod model;
mod scope;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::thread;
use std::time::Duration;

use ducky_hc::{Client, Event, EventMessage, SubscribeParams, Subscription, Terminal};

pub use agent::{AgentInfo, AgentKind, AgentStatus};
pub use scope::{DirectoryScope, machine_of};

use crate::ticket::{TaskProgress, TaskTicket};
use model::{Applied, Model};

/// How often the event thread checks whether its directory is still wanted.
const POLL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Connection {
    Connected,
    Disconnected(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirectoryEvent {
    /// Re-read [`AgentDirectory::agents`]. `address` is the terminal that changed; `None` after a
    /// fresh snapshot, when anything may have.
    Changed {
        address: Option<String>,
    },
    /// An agent in the repo finished a turn: a good moment to reload notes.
    TurnEnded {
        address: String,
        turn: u64,
    },
    /// News about a task handed over with [`crate::Tasks`] and passed to [`AgentDirectory::track`].
    Task {
        ticket: TaskTicket,
        progress: TaskProgress,
    },
    Disconnected {
        reason: String,
    },
}

/// Cheap to clone; the event thread ends shortly after the last clone is dropped.
#[derive(Clone)]
pub struct AgentDirectory {
    inner: Arc<Inner>,
}

struct Inner {
    scope: DirectoryScope,
    state: Mutex<State>,
    events: flume::Sender<DirectoryEvent>,
    generation: AtomicU64,
}

struct State {
    model: Model,
    connection: Connection,
    tickets: Vec<TaskTicket>,
}

impl AgentDirectory {
    /// Subscribes on `client` and returns the directory with its event channel. On this machine
    /// the scope's folders also match their resolved paths.
    pub fn start(
        client: Client,
        scope: DirectoryScope,
    ) -> ducky_hc::Result<(Self, flume::Receiver<DirectoryEvent>)> {
        let (events, rx) = flume::unbounded();
        let directory = Self {
            inner: Arc::new(Inner {
                scope: scope.with_local_aliases(),
                state: Mutex::new(State {
                    model: Model::default(),
                    connection: Connection::Connected,
                    tickets: Vec::new(),
                }),
                events,
                generation: AtomicU64::new(0),
            }),
        };
        directory.reconnect(client)?;
        Ok((directory, rx))
    }

    /// Subscribes again on a new client and replaces the list with its snapshot.
    pub fn reconnect(&self, client: Client) -> ducky_hc::Result<()> {
        let subscription = client.subscribe(&SubscribeParams::default())?;
        let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.inner
            .reset(subscription.snapshot().terminals.clone(), true);
        let weak = Arc::downgrade(&self.inner);
        thread::Builder::new()
            .name("ducky-agents-directory".into())
            .spawn(move || follow(&weak, generation, &client, subscription))?;
        Ok(())
    }

    pub fn scope(&self) -> &DirectoryScope {
        &self.inner.scope
    }

    pub fn connection(&self) -> Connection {
        self.inner.state().connection.clone()
    }

    /// The repo's terminals: live ones first, each group oldest first.
    pub fn agents(&self) -> Vec<AgentInfo> {
        let state = self.inner.state();
        let mut agents: Vec<AgentInfo> = state
            .model
            .terminals()
            .filter(|t| self.inner.scope.matches(t))
            .map(AgentInfo::from_terminal)
            .collect();
        agents.sort_by_key(|a| (!a.is_live(), a.created_ms));
        agents
    }

    /// Any terminal the core reported, in the repo or not.
    pub fn agent(&self, address: &str) -> Option<AgentInfo> {
        self.inner
            .state()
            .model
            .get(address)
            .map(AgentInfo::from_terminal)
    }

    /// Reports the task's progress as [`DirectoryEvent::Task`] until it finishes. Checked at
    /// once too, in case the turn already ended.
    pub fn track(&self, ticket: TaskTicket) {
        let address = ticket.address.clone();
        let news = {
            let mut state = self.inner.state();
            state.tickets.push(ticket);
            state.check_tickets(Some(&address))
        };
        self.inner.emit(news);
    }

    pub fn tracked(&self) -> Vec<TaskTicket> {
        self.inner.state().tickets.clone()
    }
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn emit(&self, events: Vec<DirectoryEvent>) {
        for event in events {
            let _ = self.events.send(event);
        }
    }

    fn reset(&self, terminals: Vec<Terminal>, connected: bool) {
        let news = {
            let mut state = self.state();
            state.model.reset(terminals);
            if connected {
                state.connection = Connection::Connected;
            }
            let mut news = vec![DirectoryEvent::Changed { address: None }];
            news.extend(state.check_tickets(None));
            news
        };
        self.emit(news);
    }

    fn apply(&self, client: &Client, event: &Event) {
        let Some(address) = event.terminal.as_deref() else {
            return;
        };
        let in_scope = |state: &State| {
            state
                .model
                .get(address)
                .is_some_and(|t| self.scope.matches(t))
        };
        let (was_in, applied) = {
            let mut state = self.state();
            (in_scope(&state), state.model.apply(event))
        };
        if applied == Applied::Refetch {
            let fetched = client.terminal_get(address);
            let mut state = self.state();
            match fetched {
                Ok(terminal) => state.model.set(terminal),
                Err(error) if error.kind() == Some("not_found") => state.model.remove(address),
                Err(_) => {}
            }
        }
        let news = {
            let mut state = self.state();
            let now_in = in_scope(&state);
            let mut news = Vec::new();
            if (was_in || now_in) && applied != Applied::Ignored {
                news.push(DirectoryEvent::Changed {
                    address: Some(address.to_owned()),
                });
            }
            if applied == Applied::TurnEnded
                && now_in
                && let Some(terminal) = state.model.get(address)
            {
                news.push(DirectoryEvent::TurnEnded {
                    address: address.to_owned(),
                    turn: terminal.turn,
                });
            }
            news.extend(state.check_tickets(Some(address)));
            news
        };
        self.emit(news);
    }

    fn disconnected(&self, generation: u64, reason: String) {
        if self.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        self.state().connection = Connection::Disconnected(reason.clone());
        self.emit(vec![DirectoryEvent::Disconnected { reason }]);
    }
}

impl State {
    fn check_tickets(&mut self, address: Option<&str>) -> Vec<DirectoryEvent> {
        let mut news = Vec::new();
        let model = &self.model;
        self.tickets.retain_mut(|ticket| {
            if address.is_some_and(|a| a != ticket.address) {
                return true;
            }
            let Some(progress) = ticket.progress(model.get(&ticket.address)) else {
                return true;
            };
            let finished = matches!(progress, TaskProgress::Finished(_));
            news.push(DirectoryEvent::Task {
                ticket: ticket.clone(),
                progress,
            });
            !finished
        });
        news
    }
}

fn follow(weak: &Weak<Inner>, generation: u64, client: &Client, mut subscription: Subscription) {
    loop {
        let message = subscription.recv_timeout(POLL);
        let Some(inner) = weak.upgrade() else {
            return;
        };
        if inner.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        match message {
            Ok(None | Some(EventMessage::Heartbeat { .. })) => {}
            Ok(Some(EventMessage::Event(event))) => inner.apply(client, &event),
            Ok(Some(EventMessage::Missed(snapshot))) => inner.reset(snapshot.terminals, false),
            Ok(Some(EventMessage::Closed(reason))) => {
                let reason = reason
                    .and_then(|r| r["reason"].as_str().map(str::to_owned))
                    .unwrap_or_else(|| "herdr-core ended the subscription".into());
                inner.disconnected(generation, reason);
                return;
            }
            Err(error) => {
                inner.disconnected(generation, error.to_string());
                return;
            }
        }
    }
}
