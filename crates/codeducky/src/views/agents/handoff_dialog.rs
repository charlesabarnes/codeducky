//! Which agent takes a hand-off when several could, and the text of a custom message.

use ducky_agents::{AgentInfo, Task};
use ducky_session::agents::{Recipient, status_text, tone};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Textarea, TextareaState};
use gpui_kit::component::{ActiveTheme, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::tabs::status_dot;
use crate::keymap::{SAVE_KEYS, SubmitDialog};
use crate::theme::ActiveCode;
use crate::views::dialog::{backdrop, error_line, field, frame};
use crate::views::widgets::muted;
use crate::views::workspace::Workspace;

pub struct HandOffDialog {
    workspace: WeakEntity<Workspace>,
    /// `None`: a message the person types here.
    task: Option<Task>,
    title: String,
    message: Entity<TextareaState>,
    choices: Vec<AgentInfo>,
    picked: Recipient,
    error: Option<String>,
}

impl HandOffDialog {
    pub fn new(
        workspace: WeakEntity<Workspace>,
        title: String,
        task: Option<Task>,
        choices: Vec<AgentInfo>,
        picked: Recipient,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let message = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(3, 12)
                .placeholder("What should the agent do?")
        });
        if task.is_none() {
            message.update(cx, |input, cx| input.focus(window, cx));
        }
        Self {
            workspace,
            task,
            title,
            message,
            choices,
            picked,
            error: None,
        }
    }

    pub fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let task = match &self.task {
            Some(task) => task.clone(),
            None => {
                let text = self.message.read(cx).value().trim().to_owned();
                if text.is_empty() {
                    self.error = Some("write a message first".into());
                    cx.notify();
                    return;
                }
                Task::custom(text)
            }
        };
        let picked = self.picked.clone();
        self.workspace
            .update(cx, |ws, cx| ws.hand_off(picked, task, window, cx))
            .ok();
    }

    fn row(&self, i: usize, agent: &AgentInfo, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let code = *cx.code();
        let recipient = Recipient::Agent(agent.address.clone());
        let on = self.picked == recipient;
        h_flex()
            .id(("handoff-agent", i))
            .gap_2()
            .px_2()
            .py_1()
            .rounded(theme.radius)
            .cursor_pointer()
            .when(on, |this| this.bg(code.row_current))
            .hover(|this| this.bg(code.bg_2))
            .child(status_dot(tone(&agent.status), cx))
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(agent.name.clone().unwrap_or_else(|| agent.address.clone())),
            )
            .child(muted(
                format!("{} · {}", agent.kind.label(), status_text(&agent.status)),
                cx,
            ))
            .child(div().flex_1())
            .child(muted(agent.address.clone(), cx))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.picked = recipient.clone();
                cx.notify();
            }))
    }
}

impl Render for HandOffDialog {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let code = *cx.code();
        let theme = cx.theme().clone();
        let rows: Vec<AnyElement> = self
            .choices
            .clone()
            .iter()
            .enumerate()
            .map(|(i, agent)| self.row(i, agent, cx).into_any_element())
            .collect();
        let new_on = self.picked == Recipient::NewAgent;
        let new_row = h_flex()
            .id("handoff-new")
            .gap_2()
            .px_2()
            .py_1()
            .rounded(theme.radius)
            .cursor_pointer()
            .when(new_on, |this| this.bg(code.row_current))
            .hover(|this| this.bg(code.bg_2))
            .child(div().text_color(code.accent).child("+"))
            .child("a new agent")
            .on_click(cx.listener(|this, _, _, cx| {
                this.picked = Recipient::NewAgent;
                cx.notify();
            }));
        let card = frame("hand-off", self.title.clone(), 560., cx)
            .on_action(cx.listener(|this, _: &SubmitDialog, window, cx| this.submit(window, cx)))
            .when(self.task.is_none(), |this| {
                this.child(field("message", Textarea::new(&self.message), cx))
            })
            .child(field(
                "send to",
                v_flex().gap_0p5().children(rows).child(new_row),
                cx,
            ))
            .children(error_line(self.error.as_deref(), cx))
            .child(
                h_flex()
                    .gap_2()
                    .justify_end()
                    .child(muted(SAVE_KEYS, cx))
                    .child(
                        Button::new("hand-off-go")
                            .label("Send")
                            .small()
                            .primary()
                            .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx))),
                    ),
            );
        backdrop(v_flex().child(card), cx)
    }
}
