//! Rename a machine. Only this core's name for it changes; addresses with the old one stop
//! working, and its recent repos follow it.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{Sizable as _, h_flex, v_flex};
use gpui_kit::*;

use crate::keymap::SubmitDialog;
use crate::views::dialog::{backdrop, error_line, field, frame};
use crate::views::widgets::muted;
use crate::views::workspace::Workspace;

pub struct RenameMachineDialog {
    workspace: WeakEntity<Workspace>,
    machine: String,
    name: Entity<InputState>,
    error: Option<String>,
    _subscription: Subscription,
}

impl RenameMachineDialog {
    pub fn new(
        workspace: WeakEntity<Workspace>,
        machine: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let current = machine.clone();
        let name = cx.new(|cx| InputState::new(window, cx).default_value(current));
        let subscription =
            cx.subscribe_in(&name, window, |this, _, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) {
                    this.submit(window, cx);
                }
            });
        name.update(cx, |input, cx| input.focus(window, cx));
        Self {
            workspace,
            machine,
            name,
            error: None,
            _subscription: subscription,
        }
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let to = self.name.read(cx).value().trim().to_owned();
        let Some(workspace) = self.workspace.upgrade() else {
            return;
        };
        let from = self.machine.clone();
        let task = workspace.update(cx, |ws, cx| {
            ws.machines.update(cx, |m, cx| m.rename(from, to, cx))
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            this.update_in(cx, |this, window, cx| match result {
                Ok(_) => workspace.update(cx, |ws, cx| ws.close_dialog(window, cx)),
                Err(error) => {
                    this.error = Some(error.text);
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }
}

impl Render for RenameMachineDialog {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let card = frame(
            "rename-machine",
            format!("Rename {}", self.machine),
            440.,
            cx,
        )
        .on_action(cx.listener(|this, _: &SubmitDialog, window, cx| this.submit(window, cx)))
        .child(muted(
            "Only this herdr-core's name for it changes; its terminals are addressed by the \
                 new name from now on.",
            cx,
        ))
        .child(field("new name", Input::new(&self.name).small(), cx))
        .children(error_line(self.error.as_deref(), cx))
        .child(
            h_flex().justify_end().child(
                Button::new("rename-machine-go")
                    .label("Rename")
                    .small()
                    .primary()
                    .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx))),
            ),
        );
        backdrop(v_flex().child(card), cx)
    }
}
