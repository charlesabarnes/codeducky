//! Banners above the diff: the pull request's head moved since it was loaded.

use gpui_kit::component::{ActiveTheme, h_flex};
use gpui_kit::*;

use crate::keymap::{REFRESH_KEYS, Refresh};
use crate::theme::ActiveCode;
use crate::views::widgets::{key_hint, short_sha};
use crate::views::workspace::Workspace;

pub fn head_moved(ws: &Workspace, cx: &App) -> Option<AnyElement> {
    let pull = ws.pull.read(cx);
    let moved = pull.moved_to.as_deref()?;
    let loaded = pull.context()?.head_sha().to_owned();
    let code = cx.code();
    Some(
        h_flex()
            .id("head-moved")
            .px(code.metrics.pad_x)
            .py_1()
            .gap_3()
            .bg(code.modified.opacity(0.16))
            .border_b_1()
            .border_color(cx.theme().border)
            .child(div().text_color(code.modified).child("●"))
            .child(format!(
                "The pull request's head moved to {} since you loaded {}.",
                short_sha(moved),
                short_sha(&loaded)
            ))
            .child(div().flex_1())
            .child(
                h_flex()
                    .id("head-moved-refresh")
                    .gap_1()
                    .cursor_pointer()
                    .text_color(code.accent)
                    .child("refresh")
                    .child(key_hint(REFRESH_KEYS, cx))
                    .on_click(|_, w, cx| w.dispatch_action(Box::new(Refresh), cx)),
            )
            .into_any_element(),
    )
}
