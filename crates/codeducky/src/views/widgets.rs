//! Small pieces the views share: key hints, toggles, badges, counts.

use ducky_session::FileBadge;
use gpui_kit::component::ActiveTheme;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::theme::ActiveCode;

pub fn key_hint(keys: &'static str, cx: &App) -> Div {
    div()
        .font_family(cx.theme().mono_font_family.clone())
        .text_color(cx.code().accent)
        .child(keys)
}

/// A toggle in the TypeScript app's style: a label, its key, and a filled look when on.
pub fn toggle(
    id: &'static str,
    label: impl Into<SharedString>,
    keys: &'static str,
    on: bool,
    cx: &App,
) -> Stateful<Div> {
    let code = cx.code();
    let theme = cx.theme();
    div()
        .id(id)
        .flex()
        .items_center()
        .gap_1()
        .px_1p5()
        .rounded(theme.radius)
        .cursor_pointer()
        .when(on, |this| {
            this.bg(theme.foreground).text_color(theme.background)
        })
        .when(!on, |this| this.hover(|this| this.bg(code.bg_3)))
        .child(label.into())
        .child(
            div()
                .font_family(theme.mono_font_family.clone())
                .text_color(if on { theme.background } else { code.accent })
                .child(keys),
        )
}

pub fn badge_color(badge: FileBadge, cx: &App) -> Hsla {
    let code = cx.code();
    match badge {
        FileBadge::Added => code.add,
        FileBadge::Deleted => code.del,
        FileBadge::Renamed | FileBadge::Copied => code.moved,
        FileBadge::Modified | FileBadge::TypeChanged => code.modified,
        FileBadge::Conflicted => code.del,
    }
}

pub fn counts(additions: u32, deletions: u32, cx: &App) -> Div {
    let code = cx.code();
    div()
        .flex()
        .gap_1()
        .child(div().text_color(code.add).child(format!("+{additions}")))
        .child(div().text_color(code.del).child(format!("−{deletions}")))
}

pub fn muted(text: impl Into<SharedString>, cx: &App) -> Div {
    div()
        .text_color(cx.theme().muted_foreground)
        .child(text.into())
}

/// `n viewed` as a row of small blocks, like the TypeScript app.
pub fn progress(done: usize, total: usize, cx: &App) -> Div {
    let code = cx.code();
    let blocks = total.clamp(1, 10);
    let filled = if total == 0 {
        0
    } else {
        (done * blocks).div_ceil(total).min(blocks)
    };
    div()
        .flex()
        .items_center()
        .gap(px(2.))
        .children((0..blocks).map(|i| {
            div()
                .w(px(9.))
                .h(px(9.))
                .bg(if i < filled { code.add } else { code.bg_3 })
        }))
}

pub fn short_sha(sha: &str) -> &str {
    sha.get(..7).unwrap_or(sha)
}

/// A base as typed, except a full commit id, which is shortened.
pub fn short_rev(rev: &str) -> &str {
    if rev.len() >= 12 && rev.bytes().all(|b| b.is_ascii_hexdigit()) {
        short_sha(rev)
    } else {
        rev
    }
}
