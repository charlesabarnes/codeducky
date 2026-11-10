//! Start an agent in the repo root: a template or a command, a name, and an optional first task.
//! Opened for a hand-off when no agent can take it, the hand-off is the first task.

use ducky_agents::{Program, Task};
use ducky_hc::TemplateInfo;
use ducky_session::agents::{AgentRequest, split_command};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::{Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::keymap::{SAVE_KEYS, SubmitDialog};
use crate::views::dialog::{backdrop, chip, error_line, field, frame};
use crate::views::widgets::muted;
use crate::views::workspace::Workspace;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Choice {
    Command,
    Template(String),
}

pub struct StartAgentDialog {
    workspace: WeakEntity<Workspace>,
    name: Entity<InputState>,
    command: Entity<InputState>,
    first_task: Entity<TextareaState>,
    templates: Vec<TemplateInfo>,
    choice: Choice,
    /// A hand-off that waits for this agent: sent as its first task.
    preset: Option<Task>,
    machine: Option<String>,
    error: Option<String>,
    _subscriptions: Vec<Subscription>,
}

fn task_label(task: &Task) -> String {
    match task {
        Task::Review { base } => format!("review the branch against {base}"),
        Task::Fix { notes, more_open } if *more_open > 0 => {
            format!("fix {} notes (and {more_open} more open)", notes.len())
        }
        Task::Fix { notes, .. } => format!(
            "fix {} note{}",
            notes.len(),
            if notes.len() == 1 { "" } else { "s" }
        ),
        Task::Custom { text } => format!("“{}”", text.lines().next().unwrap_or_default()),
    }
}

impl StartAgentDialog {
    pub fn new(
        workspace: WeakEntity<Workspace>,
        command: &str,
        templates: Vec<TemplateInfo>,
        preset: Option<Task>,
        machine: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let default_name = match &preset {
            Some(Task::Review { .. }) => "review",
            Some(Task::Fix { .. }) => "fix-notes",
            _ => "agent",
        };
        let name = cx.new(|cx| InputState::new(window, cx).default_value(default_name));
        let command = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("claude")
                .default_value(command)
        });
        let first_task = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(2, 8)
                .placeholder("Optional: what it should do first")
        });
        let submit_on_enter = |input: &Entity<InputState>, cx: &mut Context<Self>| {
            cx.subscribe_in(input, window, |this, _, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) {
                    this.submit(window, cx);
                }
            })
        };
        let subscriptions = vec![submit_on_enter(&name, cx), submit_on_enter(&command, cx)];
        command.update(cx, |input, cx| input.focus(window, cx));
        Self {
            workspace,
            name,
            command,
            first_task,
            templates,
            choice: Choice::Command,
            preset,
            machine,
            error: None,
            _subscriptions: subscriptions,
        }
    }

    fn request(&self, cx: &App) -> Result<AgentRequest, String> {
        let name = self.name.read(cx).value().trim().to_owned();
        if name.is_empty() {
            return Err("give it a name".into());
        }
        let program = match &self.choice {
            Choice::Template(template) => Program::Template(template.clone()),
            Choice::Command => Program::Command(split_command(&self.command.read(cx).value())?),
        };
        let typed = self.first_task.read(cx).value().trim().to_owned();
        let first_task = self
            .preset
            .clone()
            .or_else(|| (!typed.is_empty()).then(|| Task::custom(typed)));
        Ok(AgentRequest {
            name,
            program,
            first_task,
            size: None,
        })
    }

    pub fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let request = match self.request(cx) {
            Ok(request) => request,
            Err(error) => {
                self.error = Some(error);
                cx.notify();
                return;
            }
        };
        let command = match &self.choice {
            Choice::Command => Some(self.command.read(cx).value().trim().to_owned()),
            Choice::Template(_) => None,
        };
        self.workspace
            .update(cx, |ws, cx| ws.start_agent(request, command, window, cx))
            .ok();
    }
}

impl Render for StartAgentDialog {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let template_chips = self.templates.iter().enumerate().map(|(i, template)| {
            let choice = Choice::Template(template.name.clone());
            let on = self.choice == choice;
            chip(("template", i), template.name.clone(), on, cx).on_click(cx.listener(
                move |this, _, _, cx| {
                    this.choice = choice.clone();
                    cx.notify();
                },
            ))
        });
        let picked_template = match &self.choice {
            Choice::Template(name) => self.templates.iter().find(|t| &t.name == name),
            Choice::Command => None,
        };
        let where_ = match &self.machine {
            Some(machine) => format!("in the repo root on {machine}"),
            None => "in the repo root on this machine".into(),
        };
        let card = frame("start-agent", "Start an agent", 520., cx)
            .on_action(cx.listener(|this, _: &SubmitDialog, window, cx| this.submit(window, cx)))
            .child(muted(format!("It runs {where_}, in herdr-core."), cx))
            .child(field(
                "program",
                h_flex()
                    .flex_wrap()
                    .gap_1()
                    .child(
                        chip(
                            "template-none",
                            "command",
                            self.choice == Choice::Command,
                            cx,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.choice = Choice::Command;
                            cx.notify();
                        })),
                    )
                    .children(template_chips),
                cx,
            ))
            .when(self.choice == Choice::Command, |this| {
                this.child(field("command", Input::new(&self.command).small(), cx))
            })
            .children(picked_template.map(|t| {
                muted(
                    if t.description.is_empty() {
                        t.command.clone()
                    } else {
                        format!("{} — {}", t.description, t.command)
                    },
                    cx,
                )
            }))
            .child(field("name", Input::new(&self.name).small(), cx))
            .child(match &self.preset {
                Some(task) => field("first task", div().child(task_label(task)), cx),
                None => field("first task", Textarea::new(&self.first_task), cx),
            })
            .children(error_line(self.error.as_deref(), cx))
            .child(
                h_flex()
                    .gap_2()
                    .justify_end()
                    .child(muted(SAVE_KEYS, cx))
                    .child(
                        Button::new("start-agent-go")
                            .label("Start")
                            .small()
                            .primary()
                            .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx))),
                    ),
            );
        backdrop(v_flex().child(card), cx)
    }
}
