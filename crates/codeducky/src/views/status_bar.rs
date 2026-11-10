//! The bottom line: mode, file, notes, what is loading or went wrong, and key hints.

use gpui_kit::component::{ActiveTheme, h_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::keymap::{CycleAppearance, CycleDensity, CyclePalette};
use crate::theme::ActiveCode;
use crate::views::widgets::key_hint;
use crate::views::workspace::Workspace;

pub fn render(ws: &mut Workspace, _: &mut Window, cx: &mut Context<Workspace>) -> impl IntoElement {
    let theme = cx.theme().clone();
    let code = *cx.code();
    let model = ws.model.read(cx);
    let file_name = model
        .selected
        .as_deref()
        .map(|p| p.rsplit('/').next().unwrap_or(p).to_owned());
    let open_notes = model.file_notes().iter().filter(|n| n.is_open()).count();
    let message = match (&model.busy, &model.status) {
        (Some(busy), _) => Some((format!("{busy}…"), theme.muted_foreground)),
        (None, Some(status)) if status.error => Some((status.text.clone(), code.del)),
        (None, Some(status)) => Some((status.text.clone(), theme.muted_foreground)),
        (None, None) => None,
    };
    let hint = |keys: &'static str, label: &'static str| {
        h_flex().gap_1().child(key_hint(keys, cx)).child(label)
    };
    h_flex()
        .h(code.metrics.status)
        .flex_none()
        .gap_4()
        .pr(code.metrics.pad_x)
        .bg(theme.status_bar)
        .border_t_1()
        .border_color(theme.status_bar_border)
        .font_family(theme.mono_font_family.clone())
        .child(
            div()
                .h_full()
                .px(code.metrics.pad_x)
                .flex()
                .items_center()
                .bg(code.accent)
                .text_color(code.accent_fg)
                .font_weight(FontWeight::BOLD)
                .child(match (&model.review, model.pane, &model.mode) {
                    (None, _, _) => "OPEN",
                    (Some(_), crate::state::Pane::Edit, _) => "EDIT",
                    (Some(_), _, ducky_session::ReviewMode::Since) => "SINCE",
                    (Some(_), _, ducky_session::ReviewMode::Commits { .. }) => "COMMITS",
                    (Some(_), _, ducky_session::ReviewMode::All) => "REVIEW",
                }),
        )
        .children(file_name)
        .when(model.review.is_some(), |this| {
            this.child(format!(
                "{open_notes} note{}",
                if open_notes == 1 { "" } else { "s" }
            ))
        })
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .children(message.map(|(text, color)| div().text_color(color).child(text))),
        )
        .when(model.unsaved.is_some(), |this| {
            this.child(div().text_color(code.modified).child("unsaved"))
        })
        .when(model.pane == crate::state::Pane::Edit, |this| {
            this.child(hint(crate::keymap::SAVE_FILE_KEYS, "save"))
                .child(hint(crate::keymap::LEAVE_EDITOR_KEYS, "diff"))
        })
        .when(
            model.review.is_some() && model.pane == crate::state::Pane::Diff,
            |this| {
                this.child(hint("j/k", "line"))
                    .child(hint("n/p", "change"))
                    .child(hint("]/[", "file"))
                    .child(hint("c", "comment"))
            },
        )
        .child(hint("?", "help"))
        .child(look_switch(
            "look-palette",
            model.prefs.palette.name(),
            CyclePalette,
            cx,
        ))
        .child(look_switch(
            "look-appearance",
            model.prefs.appearance.name(),
            CycleAppearance,
            cx,
        ))
        .child(look_switch(
            "look-density",
            model.prefs.density.name(),
            CycleDensity,
            cx,
        ))
}

fn look_switch(
    id: &'static str,
    label: &'static str,
    action: impl Action + Clone,
    cx: &App,
) -> impl IntoElement {
    let code = cx.code();
    div()
        .id(id)
        .px_1()
        .cursor_pointer()
        .text_color(cx.theme().muted_foreground)
        .hover(|this| this.bg(code.bg_3))
        .child(label)
        .on_click(move |_, window, cx| window.dispatch_action(action.boxed_clone(), cx))
}
