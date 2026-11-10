//! Pick one commit, or shift-click a second for a range, oldest first.

use ducky_review::BranchCommit;
use ducky_session::ReviewMode;
use gpui_kit::component::{ActiveTheme, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::theme::ActiveCode;
use crate::views::widgets::{counts, muted};
use crate::views::workspace::Workspace;

pub fn render(ws: &mut Workspace, cx: &mut Context<Workspace>) -> AnyElement {
    let theme = cx.theme().clone();
    let code = *cx.code();
    let model = ws.model.read(cx);
    let range = model.commit_range();
    let all_on = model.mode == ReviewMode::All;
    let Some(review) = model.review.clone() else {
        return div().into_any_element();
    };
    let all_row = div()
        .id("commit-all")
        .px_2()
        .py_0p5()
        .cursor_pointer()
        .when(all_on, |this| this.bg(code.row_current))
        .hover(|this| this.bg(code.bg_2))
        .child("All changes")
        .on_click(cx.listener(|ws, _, _, cx| {
            ws.model.update(cx, |m, cx| {
                m.show_commit_picker = false;
                m.set_review_mode(ReviewMode::All, cx);
            })
        }));
    let rows = review.commits.iter().enumerate().map(|(i, commit)| {
        let on = range.is_some_and(|r| (r.from..=r.to).contains(&i));
        let stats = review.commit_stats.get(&commit.sha).copied();
        commit_row(i, commit, stats, on, cx)
    });
    let footer = if review.commits.is_empty() {
        "No commits on this branch yet."
    } else {
        "Shift-click a second commit to review a range. { and } step through them."
    };
    div()
        .absolute()
        .top(code.metrics.bar + px(4.))
        .left(code.metrics.sidebar + px(4.))
        .child(
            v_flex()
                .id("commit-picker")
                .w(px(560.))
                .max_h(px(480.))
                .overflow_y_scroll()
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
                        .child("review one commit, or a range (esc closes)"),
                )
                .child(all_row)
                .children(rows)
                .when(review.commits_truncated, |this| {
                    this.child(
                        div()
                            .px_2()
                            .child(muted("Only the most recent commits are listed.", cx)),
                    )
                })
                .child(div().px_2().pt_1().child(muted(footer, cx))),
        )
        .into_any_element()
}

fn commit_row(
    index: usize,
    commit: &BranchCommit,
    stats: Option<ducky_git::CommitStats>,
    on: bool,
    cx: &mut Context<Workspace>,
) -> Stateful<Div> {
    let theme = cx.theme().clone();
    let code = *cx.code();
    let meta = format!("{} · {}", commit.author, commit.date.minute_utc());
    v_flex()
        .id(("commit-row", index))
        .px_2()
        .py_0p5()
        .cursor_pointer()
        .when(on, |this| this.bg(code.row_current))
        .when(!on, |this| this.hover(|this| this.bg(code.bg_2)))
        .child(
            h_flex()
                .gap_2()
                .child(
                    div()
                        .text_color(code.accent)
                        .child(commit.short_sha().to_owned()),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .child(commit.summary().to_owned()),
                )
                .when(commit.is_merge(), |this| {
                    this.child(div().text_color(code.moved).child("merge"))
                }),
        )
        .child(
            h_flex()
                .gap_2()
                .text_color(theme.muted_foreground)
                .child(div().flex_1().child(meta))
                .children(stats.map(|s| {
                    h_flex()
                        .gap_1()
                        .child(format!(
                            "{} file{}",
                            s.files,
                            if s.files == 1 { "" } else { "s" }
                        ))
                        .child(counts(s.additions, s.deletions, cx))
                })),
        )
        .on_click(cx.listener(move |ws, event: &ClickEvent, _, cx| {
            let extend = event.modifiers().shift;
            ws.model
                .update(cx, |m, cx| m.pick_commit(index, extend, cx));
        }))
}
