//! The sidebar's mode bar: all changes, since last look, or commits, and what each says.

use ducky_review::last_look::SinceCounts;
use ducky_session::{HeadMoved, ReviewMode};
use gpui_kit::component::{ActiveTheme, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::keymap::{
    AllChanges, CommitPicker, MarkReviewed, NextCommit, PrevCommit, ToggleSince, ToggleUnchanged,
};
use crate::theme::ActiveCode;
use crate::views::widgets::{muted, short_sha, toggle};
use crate::views::workspace::Workspace;

pub fn render(ws: &mut Workspace, cx: &mut Context<Workspace>) -> AnyElement {
    let theme = cx.theme().clone();
    let code = *cx.code();
    let model = ws.model.read(cx);
    let Some(review) = model.review.clone() else {
        return div().into_any_element();
    };
    let (mode, show_unchanged, dismissed, range) = (
        model.mode.clone(),
        model.show_unchanged,
        model.since_banner_dismissed,
        model.commit_range(),
    );
    let view = model.view.clone();
    let since = review.since.as_ref();
    let mode = &mode;
    let since_label = match since.map(|s| s.to_review()) {
        Some(n) if n > 0 => format!("since last look ({n})"),
        _ => "since last look".to_owned(),
    };
    let commits_label = match (&view, mode) {
        (Some(view), ReviewMode::Commits { .. }) => view
            .commit
            .as_ref()
            .map_or("commits".to_owned(), |c| c.label.clone()),
        _ => format!("commits ({})", review.commits.len()),
    };
    let bar = h_flex()
        .flex_wrap()
        .gap_1()
        .child(
            toggle("mode-all", "all", "g a", *mode == ReviewMode::All, cx)
                .on_click(|_, w, cx| w.dispatch_action(Box::new(AllChanges), cx)),
        )
        .child(
            toggle(
                "mode-since",
                since_label,
                "L",
                *mode == ReviewMode::Since,
                cx,
            )
            .on_click(|_, w, cx| w.dispatch_action(Box::new(ToggleSince), cx)),
        )
        .child(
            toggle("mode-commits", commits_label, "g k", mode.is_commits(), cx)
                .max_w_full()
                .overflow_hidden()
                .on_click(|_, w, cx| w.dispatch_action(Box::new(CommitPicker), cx)),
        );

    let mut lines: Vec<AnyElement> = Vec::new();
    match mode {
        ReviewMode::Since => {
            if let Some(since) = since {
                lines.push(since_summary(&since.counts, show_unchanged, cx));
            }
            lines.push(
                h_flex()
                    .gap_2()
                    .child(
                        toggle("mark-reviewed", "mark reviewed", "V", false, cx)
                            .on_click(|_, w, cx| w.dispatch_action(Box::new(MarkReviewed), cx)),
                    )
                    .into_any_element(),
            );
        }
        ReviewMode::Commits { .. } => {
            if let (Some(range), Some(view)) = (range, &view) {
                let total = review.commits.len();
                let position = if range.is_single() {
                    format!("commit {} of {total}", range.from + 1)
                } else {
                    format!("commits {}–{} of {total}", range.from + 1, range.to + 1)
                };
                let files = view.entries.len();
                lines.push(
                    h_flex()
                        .gap_2()
                        .child(muted(format!("{position} · {files} files"), cx))
                        .child(div().flex_1())
                        .child(
                            toggle("prev-commit", "‹", "{", false, cx)
                                .on_click(|_, w, cx| w.dispatch_action(Box::new(PrevCommit), cx)),
                        )
                        .child(
                            toggle("next-commit", "›", "}", false, cx)
                                .on_click(|_, w, cx| w.dispatch_action(Box::new(NextCommit), cx)),
                        )
                        .into_any_element(),
                );
            }
        }
        ReviewMode::All => {}
    }
    let banner = since
        .and_then(|s| s.head_moved.as_ref().map(|moved| (moved, s)))
        .filter(|_| !dismissed && !mode.is_commits())
        .map(|(moved, since)| {
            let unviewed = review.files.len() - review.viewed_count();
            head_moved_banner(
                moved,
                since.counts.changed + since.counts.missing,
                unviewed,
                *mode == ReviewMode::Since,
                cx,
            )
        });

    v_flex()
        .px(code.metrics.pad_x)
        .pb(code.metrics.pad_y)
        .gap_1()
        .font_family(theme.mono_font_family.clone())
        .child(bar)
        .children(lines)
        .children(banner)
        .into_any_element()
}

fn since_summary(
    counts: &SinceCounts,
    show_unchanged: bool,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let code = *cx.code();
    let mut parts = Vec::new();
    if counts.changed > 0 {
        parts.push(format!("{} changed since your last look", counts.changed));
    }
    if counts.missing > 0 {
        parts.push(format!(
            "{} changed (reviewed version not here)",
            counts.missing
        ));
    }
    if counts.fresh > 0 {
        parts.push(format!("{} not viewed yet", counts.fresh));
    }
    let text = if parts.is_empty() {
        "Nothing changed since your last look.".to_owned()
    } else {
        parts.join(", ")
    };
    let unchanged = (counts.unchanged > 0).then(|| {
        let label = if show_unchanged {
            format!("hide {} unchanged", counts.unchanged)
        } else {
            format!("{} unchanged hidden", counts.unchanged)
        };
        div()
            .id("toggle-unchanged")
            .cursor_pointer()
            .text_color(code.accent)
            .child(label)
            .on_click(|_, w, cx| w.dispatch_action(Box::new(ToggleUnchanged), cx))
    });
    v_flex()
        .child(div().w_full().child(text))
        .children(unchanged)
        .into_any_element()
}

fn head_moved_banner(
    moved: &HeadMoved,
    changed: usize,
    unviewed: usize,
    in_since: bool,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let theme = cx.theme().clone();
    let code = *cx.code();
    let bracket = match (moved.rewritten, moved.commits) {
        (true, _) => format!(" (history rewritten since {})", short_sha(&moved.from)),
        (false, Some(n)) => format!(" ({n} commit{})", if n == 1 { "" } else { "s" }),
        (false, None) => String::new(),
    };
    let headline = format!(
        "{changed} file{} changed since you last reviewed{bracket}.",
        if changed == 1 { "" } else { "s" }
    );
    v_flex()
        .p_1()
        .gap_0p5()
        .rounded(theme.radius)
        .border_1()
        .border_color(code.modified.opacity(0.5))
        .bg(code.modified.opacity(0.08))
        .child(div().font_weight(FontWeight::BOLD).child(headline))
        .when(unviewed > 0, |this| {
            this.child(format!(
                "{unviewed} file{} you have not viewed yet.",
                if unviewed == 1 { "" } else { "s" }
            ))
        })
        .child(muted(
            format!(
                "Last reviewed at {}, now at {}.",
                short_sha(&moved.from),
                short_sha(&moved.to)
            ),
            cx,
        ))
        .child(
            h_flex()
                .gap_2()
                .when(!in_since, |this| {
                    this.child(
                        toggle(
                            "banner-since",
                            "show changes since last look",
                            "L",
                            false,
                            cx,
                        )
                        .on_click(|_, w, cx| w.dispatch_action(Box::new(ToggleSince), cx)),
                    )
                })
                .child(
                    div()
                        .id("banner-dismiss")
                        .cursor_pointer()
                        .text_color(theme.muted_foreground)
                        .child("dismiss")
                        .on_click(cx.listener(|ws, _, _, cx| {
                            ws.model.update(cx, |m, cx| {
                                m.since_banner_dismissed = true;
                                cx.notify();
                            })
                        })),
                ),
        )
        .into_any_element()
}
