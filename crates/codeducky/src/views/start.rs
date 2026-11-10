//! No review open: pick a machine (this one or a herdr-core one), then a checkout on it — by path,
//! by browsing, or from that machine's recent repos.

use ducky_session::ReviewRequest;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::Input;
use gpui_kit::component::{ActiveTheme, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::theme::ActiveCode;
use crate::views::machines::{machine_label, picker};
use crate::views::widgets::muted;
use crate::views::workspace::Workspace;

pub fn render(ws: &mut Workspace, _: &mut Window, cx: &mut Context<Workspace>) -> impl IntoElement {
    let machines = picker::render(ws, cx).into_any_element();
    let picked = ws.machines.read(cx).picked.clone();
    let model = ws.model.read(cx);
    let theme = cx.theme();
    let code = cx.code();
    let recent: Vec<_> = model.prefs.recent_on(picked.as_deref()).cloned().collect();
    let empty = recent.is_empty();
    let on_label = machine_label(picked.as_deref());

    let recent_rows = recent.into_iter().enumerate().map(|(i, repo)| {
        div()
            .id(("recent", i))
            .px_2()
            .py_1()
            .rounded(theme.radius)
            .font_family(theme.mono_font_family.clone())
            .cursor_pointer()
            .hover(|this| this.bg(code.bg_2))
            .child(repo.path.clone())
            .on_click(cx.listener(move |ws, _, window, cx| {
                ws.open(
                    ReviewRequest {
                        path: repo.path.clone(),
                        machine: repo.machine.clone(),
                        base: None,
                    },
                    window,
                    cx,
                );
            }))
    });

    div().flex_1().min_h_0().flex().justify_center().child(
        v_flex()
            .id("start")
            .w(px(640.))
            .mt(px(56.))
            .gap_5()
            .overflow_y_scroll()
            .child(
                v_flex()
                    .gap_1()
                    .child(
                        div()
                            .text_size(px(18.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Open a repository"),
                    )
                    .child(muted(
                        "Review the checked-out branch against its base: every change since the \
                         branch left it, committed or not.",
                        cx,
                    )),
            )
            .child(machines)
            .child(
                v_flex()
                    .gap_1()
                    .child(muted(format!("checkout on {on_label}"), cx))
                    .child(
                        h_flex()
                            .gap_2()
                            .child(div().flex_1().child(Input::new(&ws.path_input).small()))
                            .child(
                                Button::new("browse").label("Browse…").small().on_click(
                                    cx.listener(|ws, _, window, cx| ws.browse(window, cx)),
                                ),
                            )
                            .child(
                                Button::new("open")
                                    .label("Open")
                                    .small()
                                    .primary()
                                    .on_click(cx.listener(|ws, _, window, cx| {
                                        ws.open_from_inputs(window, cx)
                                    })),
                            ),
                    ),
            )
            .child(
                v_flex()
                    .gap_1()
                    .child(muted("pull requests on GitHub", cx))
                    .child(
                        h_flex()
                            .gap_2()
                            .child(Button::new("open-inbox").label("Inbox").small().on_click(
                                |_, w, cx| {
                                    w.dispatch_action(Box::new(crate::keymap::OpenInbox), cx)
                                },
                            ))
                            .child(muted(
                                "pull requests waiting on you; or paste a link there (g i)",
                                cx,
                            )),
                    ),
            )
            .child(
                v_flex()
                    .gap_1()
                    .child(muted(format!("recent on {on_label}"), cx))
                    .children(recent_rows)
                    .when(empty, |this| this.child(muted("nothing yet", cx).px_2())),
            ),
    )
}
