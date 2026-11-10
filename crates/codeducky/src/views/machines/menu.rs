//! The title bar's machine menu: where the review is, the other machines, and a way to open a
//! repo on one of them.

use gpui_kit::component::{ActiveTheme, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::{machine_label, state_dot};
use crate::theme::ActiveCode;
use crate::views::widgets::muted;
use crate::views::workspace::Workspace;

pub fn render(ws: &mut Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let theme = cx.theme().clone();
    let code = *cx.code();
    let current = ws
        .model
        .read(cx)
        .review
        .as_ref()
        .and_then(|r| r.request.machine.clone());
    let machines = ws.machines.read(cx);
    let mut entries: Vec<(
        Option<String>,
        Option<ducky_session::machines::MachineState>,
        String,
    )> = vec![(None, None, "where this app runs".into())];
    entries.extend(machines.machines.iter().map(|m| {
        (
            Some(m.name.clone()),
            Some(m.state.clone()),
            m.state.label().to_owned(),
        )
    }));
    let rows = entries
        .into_iter()
        .enumerate()
        .map(|(i, (name, state, detail))| {
            let on = name == current;
            let pick = name.clone();
            h_flex()
                .id(("machine-menu", i))
                .gap_2()
                .px_2()
                .py_1()
                .cursor_pointer()
                .when(on, |this| this.bg(code.row_current))
                .hover(|this| this.bg(code.bg_2))
                .child(state_dot(state.as_ref(), cx))
                .child(machine_label(name.as_deref()))
                .child(div().flex_1())
                .child(muted(detail, cx))
                .on_click(cx.listener(move |ws, _, window, cx| {
                    ws.show_machine_menu = false;
                    ws.close_review(window, cx);
                    ws.pick_machine(pick.clone(), window, cx);
                }))
        });
    div()
        .absolute()
        .top(code.metrics.bar + px(4.))
        .right(px(160.))
        .child(
            v_flex()
                .id("machine-menu")
                .w(px(340.))
                .py_1()
                .bg(theme.popover)
                .border_1()
                .border_color(theme.border)
                .rounded(theme.radius_lg)
                .font_family(theme.mono_font_family.clone())
                .child(
                    div()
                        .px_2()
                        .pb_1()
                        .text_color(theme.muted_foreground)
                        .child("open a repository on… (esc closes)"),
                )
                .children(rows)
                .child(
                    div()
                        .id("machine-menu-manage")
                        .px_2()
                        .pt_1()
                        .mt_1()
                        .border_t_1()
                        .border_color(theme.border)
                        .cursor_pointer()
                        .text_color(code.accent)
                        .child("manage machines…")
                        .on_click(cx.listener(|ws, _, window, cx| {
                            ws.show_machine_menu = false;
                            ws.close_review(window, cx);
                        })),
                ),
        )
}
