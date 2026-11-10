//! Add a machine: an ssh target (or a Host from ~/.ssh/config), an optional name, or a command
//! that reaches it instead of ssh. The core dials it before answering; errors show here.

use ducky_session::machines::{NewMachine, ssh_config_hosts};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{Disableable as _, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::keymap::SubmitDialog;
use crate::views::dialog::{backdrop, chip, error_line, field, frame};
use crate::views::widgets::muted;
use crate::views::workspace::Workspace;

pub struct AddMachineDialog {
    workspace: WeakEntity<Workspace>,
    pub target: Entity<InputState>,
    pub name: Entity<InputState>,
    pub via: Entity<InputState>,
    ssh_hosts: Vec<String>,
    show_via: bool,
    busy: bool,
    error: Option<String>,
    _subscriptions: Vec<Subscription>,
}

impl AddMachineDialog {
    pub fn new(
        workspace: WeakEntity<Workspace>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let target = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("vps, me@10.0.0.7:2222, or a Host from ~/.ssh/config")
        });
        let name =
            cx.new(|cx| InputState::new(window, cx).placeholder("default: the target's host"));
        let via = cx.new(|cx| {
            InputState::new(window, cx).placeholder("e.g. fly ssh console -a app --pty=false -C")
        });
        let enter = |input: &Entity<InputState>, cx: &mut Context<Self>| {
            cx.subscribe_in(input, window, |this, _, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) {
                    this.submit(window, cx);
                }
            })
        };
        let subscriptions = vec![enter(&target, cx), enter(&name, cx), enter(&via, cx)];
        target.update(cx, |input, cx| input.focus(window, cx));
        Self {
            workspace,
            target,
            name,
            via,
            ssh_hosts: ssh_config_hosts(),
            show_via: false,
            busy: false,
            error: None,
            _subscriptions: subscriptions,
        }
    }

    pub fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let value = |input: &Entity<InputState>| input.read(cx).value().trim().to_owned();
        let new = NewMachine {
            target: value(&self.target),
            name: Some(value(&self.name)),
            via: self.show_via.then(|| value(&self.via)),
        };
        let Some(workspace) = self.workspace.upgrade() else {
            return;
        };
        let task = workspace.update(cx, |ws, cx| ws.machines.update(cx, |m, cx| m.add(new, cx)));
        self.busy = true;
        self.error = None;
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            this.update_in(cx, |this, window, cx| {
                this.busy = false;
                match result {
                    Ok(entry) => {
                        workspace.update(cx, |ws, cx| {
                            ws.close_dialog(window, cx);
                            ws.pick_machine(Some(entry.name), window, cx);
                        });
                    }
                    Err(error) => this.error = Some(error.text),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

impl Render for AddMachineDialog {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let hosts = self.ssh_hosts.iter().take(12).enumerate().map(|(i, host)| {
            let host = host.clone();
            chip(("ssh-host", i), host.clone(), false, cx).on_click(cx.listener(
                move |this, _, window, cx| {
                    let host = host.clone();
                    this.target
                        .update(cx, |input, cx| input.set_value(host, window, cx));
                },
            ))
        });
        let card = frame("add-machine", "Add a machine", 540., cx)
            .on_action(cx.listener(|this, _: &SubmitDialog, window, cx| this.submit(window, cx)))
            .child(muted(
                "herdr-core dials it over ssh (keys or an agent, no password prompts) and checks \
                 that herdr-core answers there.",
                cx,
            ))
            .when(!self.show_via, |this| {
                this.child(field("ssh target", Input::new(&self.target).small(), cx))
                    .when(!self.ssh_hosts.is_empty(), |this| {
                        this.child(
                            v_flex()
                                .gap_1()
                                .child(muted("from ~/.ssh/config", cx))
                                .child(h_flex().flex_wrap().gap_1().children(hosts)),
                        )
                    })
            })
            .when(self.show_via, |this| {
                this.child(field(
                    "command that runs a shell line there (instead of ssh)",
                    Input::new(&self.via).small(),
                    cx,
                ))
            })
            .child(field(
                if self.show_via {
                    "name (needed)"
                } else {
                    "name (optional)"
                },
                Input::new(&self.name).small(),
                cx,
            ))
            .children(error_line(self.error.as_deref(), cx))
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        div()
                            .id("add-machine-via")
                            .flex_1()
                            .cursor_pointer()
                            .child(muted(
                                if self.show_via {
                                    "use ssh instead"
                                } else {
                                    "reach it with a command instead of ssh…"
                                },
                                cx,
                            ))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.show_via = !this.show_via;
                                cx.notify();
                            })),
                    )
                    .when(self.busy, |this| this.child(muted("dialling…", cx)))
                    .child(
                        Button::new("add-machine-go")
                            .label("Add")
                            .small()
                            .primary()
                            .disabled(self.busy)
                            .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx))),
                    ),
            );
        backdrop(v_flex().child(card), cx)
    }
}
