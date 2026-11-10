//! The start screen's machine list: this machine and herdr-core's, with their line and what
//! can be done with each.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{ActiveTheme, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::{machine_label, state_dot};
use crate::keymap::ReconnectCore;
use crate::theme::ActiveCode;
use crate::views::widgets::muted;
use crate::views::workspace::Workspace;

fn link(id: impl Into<ElementId>, label: &'static str, cx: &App) -> Stateful<Div> {
    let code = cx.code();
    div()
        .id(id.into())
        .px_1()
        .rounded(cx.theme().radius)
        .cursor_pointer()
        .text_color(code.accent)
        .hover(|this| this.bg(code.bg_3))
        .child(label)
}

pub fn render(ws: &mut Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let theme = cx.theme().clone();
    let code = *cx.code();
    let machines = ws.machines.read(cx);
    let local_only = ws
        .model
        .read(cx)
        .connection
        .as_ref()
        .is_none_or(|c| c.state().is_local_only());
    let picked = machines.picked.clone();
    let confirm = machines.confirm_remove.clone();
    let row = |id: ElementId, on: bool| {
        h_flex()
            .id(id)
            .gap_2()
            .px_2()
            .py_1()
            .rounded(theme.radius)
            .cursor_pointer()
            .when(on, |this| this.bg(code.row_current))
            .hover(|this| this.bg(code.bg_2))
    };
    let this_machine = row("machine-local".into(), picked.is_none())
        .child(state_dot(None, cx))
        .child(
            div()
                .font_weight(FontWeight::SEMIBOLD)
                .child(machine_label(None)),
        )
        .child(muted("where this app runs", cx))
        .on_click(cx.listener(|ws, _, window, cx| ws.pick_machine(None, window, cx)));

    let rows = machines.machines.iter().enumerate().map(|(i, machine)| {
        let name = machine.name.clone();
        let on = picked.as_deref() == Some(name.as_str());
        let detail = match (&machine.why, machine.state.is_connected()) {
            (Some(why), false) => format!("{} · {}", machine.state.label(), why),
            _ => machine.state.label().to_owned(),
        };
        let reach = if machine.via {
            "via a command".to_owned()
        } else {
            machine.target.clone()
        };
        let pick = name.clone();
        let (reconnect, rename, forget) = (name.clone(), name.clone(), name.clone());
        let main = row(("machine", i).into(), on)
            .child(state_dot(Some(&machine.state), cx))
            .child(div().font_weight(FontWeight::SEMIBOLD).child(name.clone()))
            .child(muted(reach, cx))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .text_color(if machine.state.is_connected() {
                        theme.muted_foreground
                    } else {
                        code.modified
                    })
                    .child(detail),
            )
            .child(
                link(("machine-reconnect", i), "reconnect", cx).on_click(cx.listener(
                    move |ws, _, _, cx| {
                        cx.stop_propagation();
                        let name = reconnect.clone();
                        ws.machines.update(cx, |m, cx| m.reconnect(name, cx));
                    },
                )),
            )
            .child(
                link(("machine-rename", i), "rename", cx).on_click(cx.listener(
                    move |ws, _, window, cx| {
                        cx.stop_propagation();
                        ws.open_rename_machine(rename.clone(), window, cx);
                    },
                )),
            )
            .child(
                link(("machine-forget", i), "forget", cx).on_click(cx.listener(
                    move |ws, _, _, cx| {
                        cx.stop_propagation();
                        let name = forget.clone();
                        ws.machines.update(cx, |m, cx| {
                            m.confirm_remove = Some(name);
                            cx.notify();
                        });
                    },
                )),
            )
            .on_click(cx.listener(move |ws, _, window, cx| {
                ws.pick_machine(Some(pick.clone()), window, cx)
            }));
        let confirming = confirm.as_deref() == Some(name.as_str());
        v_flex().child(main).when(confirming, |this| {
            let name = name.clone();
            this.child(
                h_flex()
                    .gap_2()
                    .ml_6()
                    .px_2()
                    .py_1()
                    .bg(code.bg_2)
                    .rounded(theme.radius)
                    .child(div().flex_1().child(format!(
                        "Forget {name}? herdr-core stops dialling it here; its terminals keep \
                         running there."
                    )))
                    .child(
                        Button::new(("machine-forget-yes", i))
                            .label("Forget")
                            .small()
                            .danger()
                            .on_click(cx.listener(move |ws, _, _, cx| {
                                let name = name.clone();
                                ws.machines.update(cx, |m, cx| m.remove(name, cx));
                            })),
                    )
                    .child(
                        Button::new(("machine-forget-no", i))
                            .label("Cancel")
                            .small()
                            .on_click(cx.listener(|ws, _, _, cx| {
                                ws.machines.update(cx, |m, cx| {
                                    m.confirm_remove = None;
                                    cx.notify();
                                });
                            })),
                    ),
            )
        })
    });

    let status = match (&machines.busy, &machines.problem) {
        (Some(busy), _) => Some(muted(format!("{busy}…"), cx)),
        (None, Some(problem)) => Some(div().text_color(code.del).child(problem.clone())),
        _ => None,
    };
    let header = h_flex()
        .gap_2()
        .child(muted("machines", cx).flex_1())
        .when(!local_only, |this| {
            this.child(
                link("machine-add", "+ add machine", cx)
                    .on_click(cx.listener(|ws, _, window, cx| ws.open_add_machine(window, cx))),
            )
            .child(link("machine-refresh", "refresh", cx).on_click(
                cx.listener(|ws, _, _, cx| ws.machines.update(cx, |m, cx| m.refresh(cx))),
            ))
        });
    v_flex()
        .gap_1()
        .child(header)
        .child(this_machine)
        .children(rows)
        .children(status)
        .when(local_only, |this| {
            this.child(
                h_flex()
                    .gap_2()
                    .px_2()
                    .child(muted(
                        "herdr-core is not running, so only this machine is available",
                        cx,
                    ))
                    .child(
                        link("core-retry", "connect again", cx).on_click(|_, window, cx| {
                            window.dispatch_action(Box::new(ReconnectCore), cx)
                        }),
                    ),
            )
        })
}
