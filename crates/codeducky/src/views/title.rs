//! The title bar: repository, branch ← base (click to change), refresh, connection, help.

use gpui_kit::component::{ActiveTheme, TitleBar, h_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::keymap::{ChangeBase, Refresh, ToggleHelp};
use crate::theme::ActiveCode;
use crate::views::widgets::{key_hint, short_rev, short_sha};
use crate::views::workspace::Workspace;

pub fn render(ws: &mut Workspace, _: &mut Window, cx: &mut Context<Workspace>) -> impl IntoElement {
    let model = ws.model.read(cx);
    let theme = cx.theme();
    let code = cx.code();
    let mono = theme.mono_font_family.clone();
    let connection = model
        .connection
        .as_ref()
        .map(|c| c.state().label())
        .unwrap_or_else(|| "connecting…".into());
    let local_only = model
        .connection
        .as_ref()
        .is_some_and(|c| c.state().is_local_only());

    let location = model.review.as_ref().map(|review| {
        let repo = review
            .toplevel()
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_owned();
        let machine = review
            .request
            .machine
            .as_ref()
            .map(|m| format!("{m}:"))
            .unwrap_or_default();
        h_flex()
            .gap_1()
            .font_family(mono.clone())
            .child(format!("{machine}{repo} / {}", review.branch_label()))
            .child(div().text_color(theme.muted_foreground).child("←"))
            .child(
                div()
                    .id("base")
                    .px_1()
                    .rounded(theme.radius)
                    .cursor_pointer()
                    .hover(|this| this.bg(code.bg_3))
                    .child(format!(
                        "{} @ {}",
                        short_rev(&review.base),
                        short_sha(&review.merge_base)
                    ))
                    .on_click(|_, window, cx| window.dispatch_action(Box::new(ChangeBase), cx)),
            )
    });

    TitleBar::new().child(
        h_flex()
            .w_full()
            .pr_3()
            .gap_4()
            .text_size(code.metrics.text)
            .child(
                h_flex()
                    .gap_1()
                    .font_family(mono.clone())
                    .font_weight(FontWeight::BOLD)
                    .child(div().text_color(code.accent).child("◆"))
                    .child("code ducky"),
            )
            .children(location)
            .child(div().flex_1())
            .when(model.review.is_some(), |this| {
                this.child(
                    h_flex()
                        .id("refresh")
                        .gap_1()
                        .cursor_pointer()
                        .child("rescan")
                        .child(key_hint(crate::keymap::REFRESH_KEYS, cx))
                        .on_click(|_, window, cx| window.dispatch_action(Box::new(Refresh), cx)),
                )
            })
            .child(
                div()
                    .text_color(if local_only {
                        code.modified
                    } else {
                        theme.muted_foreground
                    })
                    .child(connection),
            )
            .child(
                h_flex()
                    .id("help")
                    .gap_1()
                    .cursor_pointer()
                    .child("keys")
                    .child(key_hint("?", cx))
                    .on_click(|_, window, cx| window.dispatch_action(Box::new(ToggleHelp), cx)),
            ),
    )
}
