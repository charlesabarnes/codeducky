//! What the diff pane says about the mode: since-last-look state, or the commit being shown.

use ducky_review::change::short_sha;
use ducky_review::last_look::SinceKind;
use gpui_kit::component::{ActiveTheme, h_flex, v_flex};
use gpui_kit::*;

use crate::state::ReviewModel;
use crate::theme::ActiveCode;
use crate::views::diff_pane::notice_row;

pub fn render(model: &ReviewModel, path: &str, cx: &App) -> Vec<AnyElement> {
    let mut out = Vec::new();
    let Some(entry) = model.entry(path) else {
        return out;
    };
    if let Some(kind) = entry.since {
        let look = model
            .review
            .as_ref()
            .and_then(|r| r.since.as_ref())
            .and_then(|s| s.entry(path))
            .and_then(|e| e.look.as_ref());
        let when = look.map_or(String::new(), |l| {
            format!(" (viewed {})", l.at.minute_utc())
        });
        out.push(notice_row(
            match kind {
                SinceKind::Changed => {
                    format!(
                        "Changed since your last look{when}. Showing only what changed since then."
                    )
                }
                SinceKind::New => "New since last look: you have not viewed this file yet. \
                                   Showing its full diff."
                    .to_owned(),
                SinceKind::Missing => format!(
                    "Changed since your last look{when}, but the version you reviewed is no \
                     longer in this repository (git cleaned it up, or it was never stored). \
                     Showing the full diff."
                ),
                SinceKind::Unchanged => "Unchanged since your last look.".to_owned(),
            },
            cx,
        ));
    }
    if let (Some(scope), Some(review)) = (
        model.view.as_ref().and_then(|v| v.commit.as_ref()),
        model.review.as_ref(),
    ) {
        out.push(commit_header(scope, review, cx));
    }
    out
}

fn commit_header(
    scope: &ducky_session::CommitScope,
    review: &ducky_session::Review,
    cx: &App,
) -> AnyElement {
    let theme = cx.theme();
    let code = cx.code();
    let commits = &review.commits;
    let total = commits.len();
    let range = scope.range;
    let last = &commits[range.to];
    let (title, body, position) = if range.is_single() {
        let body = last
            .message
            .split_once('\n')
            .map(|(_, rest)| rest.trim().to_owned())
            .filter(|rest| !rest.is_empty());
        let merge = if last.is_merge() {
            ", a merge: diffed against its first parent"
        } else {
            ""
        };
        (
            format!("{} {}", last.short_sha(), last.summary()),
            body,
            format!(
                "{} · {} · commit {} of {total}, against its parent{merge}",
                last.author,
                last.date.minute_utc(),
                range.from + 1
            ),
        )
    } else {
        let first = &commits[range.from];
        (
            scope.label.clone(),
            None,
            format!(
                "commits {}–{} of {total}, from {}'s parent to {}",
                range.from + 1,
                range.to + 1,
                short_sha(&first.sha),
                short_sha(&last.sha)
            ),
        )
    };
    v_flex()
        .px(code.metrics.pad_x)
        .py_1()
        .gap_0p5()
        .bg(code.gap_bg)
        .border_b_1()
        .border_color(theme.border)
        .font_family(theme.mono_font_family.clone())
        .child(
            h_flex()
                .gap_2()
                .child(div().font_weight(FontWeight::BOLD).child(title)),
        )
        .children(body.map(|body| div().text_color(theme.muted_foreground).child(body)))
        .child(div().text_color(theme.muted_foreground).child(position))
        .child(div().text_color(theme.muted_foreground).child(
            "Viewed is per file for the whole branch, not per commit. Notes on lines still in \
             the final file are kept there; others stay on this commit.",
        ))
        .into_any_element()
}
