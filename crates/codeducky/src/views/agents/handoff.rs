//! The workspace's side of agents: turning "review", "fix notes" and "message" into a task and a
//! recipient, the panel and focus toggles, and toasts for what happened.

use ducky_agents::{FixScope, Task};
use ducky_session::agents::{
    AgentRequest, AgentsService, OutcomeLevel, Recipient, candidates, default_recipient,
};
use gpui_kit::component::Sizable as _;
use gpui_kit::component::WindowExt as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::notification::{Notification, NotificationType};
use gpui_kit::*;

use super::handoff_dialog::HandOffDialog;
use super::start_dialog::StartAgentDialog;
use crate::state::agents::{Line, Toast};
use crate::state::{AgentsEvent, AgentsModel};
use crate::views::workspace::{Dialog, Workspace};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ask {
    Review,
    Fix,
    Message,
}

impl Workspace {
    pub fn on_agents_event(
        &mut self,
        _: &Entity<AgentsModel>,
        event: &AgentsEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            AgentsEvent::ReloadNotes => self.model.update(cx, |m, cx| m.reload_notes(true, cx)),
            AgentsEvent::Toast(toast) => self.toast(toast.clone(), window, cx),
            AgentsEvent::Show(_) => {}
        }
    }

    fn toast(&mut self, toast: Toast, window: &mut Window, cx: &mut Context<Self>) {
        let kind = match toast.level {
            OutcomeLevel::Success => NotificationType::Success,
            OutcomeLevel::Info => NotificationType::Info,
            OutcomeLevel::Warning => NotificationType::Warning,
            OutcomeLevel::Error => NotificationType::Error,
        };
        self.last_toast = Some(toast.text.clone());
        let mut note = Notification::new()
            .message(toast.text.clone())
            .with_type(kind);
        if let Some(retry) = toast.retry {
            let agents = self.agents.downgrade();
            note = note.action(move |_, _, cx| {
                let agents = agents.clone();
                let retry = retry.clone();
                Button::new("send-anyway")
                    .label("Send anyway")
                    .small()
                    .primary()
                    .on_click(cx.listener(move |note, _, window, cx| {
                        let retry = retry.clone();
                        agents
                            .update(cx, |m, cx| m.send(retry.address, retry.task, true, cx))
                            .ok();
                        note.dismiss(window, cx);
                    }))
            });
        }
        window.push_notification(note, cx);
    }

    fn say_error(&mut self, text: impl Into<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.toast(
            Toast {
                text: text.into(),
                level: OutcomeLevel::Error,
                retry: None,
            },
            window,
            cx,
        );
    }

    pub fn set_panel_open(&mut self, open: bool, cx: &mut Context<Self>) {
        self.model.update(cx, |m, cx| {
            m.prefs.agents.open = open;
            m.save_prefs();
            cx.notify();
        });
    }

    pub fn toggle_agents(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let open = !self.model.read(cx).prefs.agents.open;
        self.set_panel_open(open, cx);
        if !open {
            window.focus(&self.focus, cx);
        }
    }

    /// From the diff to the terminal and back.
    pub fn focus_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let terminal = self.panel.read(cx).terminal_focus(cx);
        match terminal {
            Some(focus) if !focus.is_focused(window) => {
                self.set_panel_open(true, cx);
                window.focus(&focus, cx);
            }
            Some(_) => window.focus(&self.focus, cx),
            None => {
                self.set_panel_open(true, cx);
                window.focus(&self.focus, cx);
            }
        }
    }

    fn agents_ready(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        self.set_panel_open(true, cx);
        match &self.agents.read(cx).line {
            Line::Ready => true,
            Line::NeedsCore { .. } => {
                self.say_error("Agents need herdr-core, which is not running", window, cx);
                false
            }
            Line::Connecting => {
                self.say_error(
                    "Still looking for this repo's agents; try again in a moment",
                    window,
                    cx,
                );
                false
            }
            Line::Disconnected { .. } => {
                self.say_error("Lost herdr-core; reconnect first", window, cx);
                false
            }
            Line::NoReview | Line::Failed(_) => false,
        }
    }

    fn task_for(&self, ask: Ask, cx: &App) -> Result<Option<Task>, String> {
        let agents = self.agents.read(cx);
        let service = agents.service().ok_or("agents are not available")?;
        match ask {
            Ask::Review => Ok(Some(service.review_task())),
            Ask::Message => Ok(None),
            Ask::Fix => {
                let model = self.model.read(cx);
                let notes = model
                    .review
                    .as_ref()
                    .map(|r| r.notes.as_slice())
                    .unwrap_or(&[]);
                let scope = if model.fix_selection.is_empty() {
                    FixScope::AllOpen
                } else {
                    FixScope::Selected(model.fix_selection.iter().cloned().collect())
                };
                AgentsService::fix_task(notes, &scope)
                    .map(Some)
                    .map_err(|e| e.to_string())
            }
        }
    }

    /// Review, fix or message: straight to the only agent that can take it, a choice when there
    /// are several, a new agent when there is none.
    pub fn ask(&mut self, ask: Ask, window: &mut Window, cx: &mut Context<Self>) {
        if !self.agents_ready(window, cx) {
            return;
        }
        let task = match self.task_for(ask, cx) {
            Ok(task) => task,
            Err(error) => {
                self.say_error(error, window, cx);
                return;
            }
        };
        let agents = self.agents.read(cx);
        let choices: Vec<_> = candidates(&agents.agents).into_iter().cloned().collect();
        let picked = default_recipient(&agents.agents, &agents.recent);
        match (task, choices.len()) {
            (Some(task), 0) => self.open_start_dialog(Some(task), window, cx),
            (Some(task), 1) => self.hand_off(picked, task, window, cx),
            (task, _) => {
                let title = match ask {
                    Ask::Review => "Ask an agent to review",
                    Ask::Fix => "Ask an agent to fix notes",
                    Ask::Message => "Message an agent",
                };
                let workspace = cx.entity().downgrade();
                let dialog = cx.new(|cx| {
                    HandOffDialog::new(workspace, title.into(), task, choices, picked, window, cx)
                });
                self.dialog = Some(Dialog::HandOff(dialog));
                cx.notify();
            }
        }
    }

    pub fn hand_off(
        &mut self,
        recipient: Recipient,
        task: Task,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match recipient {
            Recipient::Agent(address) => {
                self.close_dialog(window, cx);
                self.agents
                    .update(cx, |m, cx| m.send(address, task, false, cx));
            }
            Recipient::NewAgent => self.open_start_dialog(Some(task), window, cx),
        }
    }

    pub fn open_start_dialog(
        &mut self,
        preset: Option<Task>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if preset.is_none() && !self.agents_ready(window, cx) {
            return;
        }
        let command = self.model.read(cx).prefs.agent_command().to_owned();
        let agents = self.agents.read(cx);
        let templates = agents.templates.clone();
        let machine = agents.machine().map(str::to_owned);
        let workspace = cx.entity().downgrade();
        let dialog = cx.new(|cx| {
            StartAgentDialog::new(workspace, &command, templates, preset, machine, window, cx)
        });
        self.dialog = Some(Dialog::StartAgent(dialog));
        cx.notify();
    }

    /// `command`: the command line used, remembered for next time.
    pub fn start_agent(
        &mut self,
        mut request: AgentRequest,
        command: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(command) = command {
            self.model.update(cx, |m, _| {
                m.prefs.agent_command = command;
                m.save_prefs();
            });
        }
        if let Some(grid) = self
            .panel
            .read(cx)
            .shown
            .as_ref()
            .and_then(|s| s.view.read(cx).grid())
        {
            request.size = Some(ducky_hc::Size {
                cols: grid.cols,
                rows: grid.rows,
            });
        }
        self.close_dialog(window, cx);
        self.set_panel_open(true, cx);
        self.agents.update(cx, |m, cx| m.start(request, cx));
    }
}
