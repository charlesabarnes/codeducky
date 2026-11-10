//! No review open: recent repositories and a path to open, on this machine or a herdr-core one.

use ducky_session::ReviewRequest;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::Input;
use gpui_kit::component::{ActiveTheme, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::theme::ActiveCode;
use crate::views::widgets::muted;
use crate::views::workspace::Workspace;

pub fn render(ws: &mut Workspace, _: &mut Window, cx: &mut Context<Workspace>) -> impl IntoElement {
    let model = ws.model.read(cx);
    let theme = cx.theme();
    let code = cx.code();
    let recent = model.prefs.recent.clone();
    let connection = model.connection.as_ref().map(|c| c.state().clone());
    let local_only = connection.as_ref().is_none_or(|c| c.is_local_only());

    let recent_rows = recent.into_iter().enumerate().map(|(i, repo)| {
        let label = match &repo.machine {
            Some(machine) => format!("{machine}:{}", repo.path),
            None => repo.path.clone(),
        };
        div()
            .id(("recent", i))
            .px_2()
            .py_1()
            .rounded(theme.radius)
            .font_family(theme.mono_font_family.clone())
            .cursor_pointer()
            .hover(|this| this.bg(code.bg_2))
            .child(label)
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
            .w(px(560.))
            .mt(px(72.))
            .gap_4()
            .child(
                div()
                    .text_size(px(18.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Open a repository"),
            )
            .child(muted(
                "Review the checked-out branch against its base: every change since the branch \
                 left it, committed or not.",
                cx,
            ))
            .child(
                v_flex()
                    .gap_2()
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
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .child(muted("machine", cx).w(px(64.)))
                            .child(
                                div().w(px(220.)).child(
                                    Input::new(&ws.machine_input).small().disabled(local_only),
                                ),
                            )
                            .child(muted(
                                if local_only {
                                    "herdr-core not running — local only"
                                } else {
                                    "a herdr-core machine name, or empty for this one"
                                },
                                cx,
                            )),
                    ),
            )
            .child(
                v_flex()
                    .gap_1()
                    .child(muted("recent", cx))
                    .children(recent_rows)
                    .when(model.prefs.recent.is_empty(), |this| {
                        this.child(muted("nothing yet", cx).px_2())
                    }),
            ), // Mount point: the machine picker and remote browsing (phase 8) go here.
    )
}
