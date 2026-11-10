//! The pull request at the top of the sidebar: title and state, branches, CI, reviewers, your
//! pending review, whether local tools work, and the push and submit buttons.

use ducky_github::PullState;
use ducky_github::reviewers::ReviewerState;
use gpui_kit::component::{ActiveTheme, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::keymap::{CiTab, PushNotes, SubmitReview};
use crate::theme::ActiveCode;
use crate::views::pull::ci;
use crate::views::widgets::muted;
use crate::views::workspace::Workspace;

pub fn reviewer_icon(state: ReviewerState, cx: &App) -> (&'static str, Hsla) {
    let code = cx.code();
    match state {
        ReviewerState::Approved => ("✓", code.add),
        ReviewerState::ChangesRequested => ("✕", code.del),
        ReviewerState::Commented => ("◦", cx.theme().muted_foreground),
        ReviewerState::Dismissed => ("–", cx.theme().muted_foreground),
        ReviewerState::Requested => ("●", code.modified),
    }
}

pub fn render(ws: &Workspace, cx: &App) -> Option<AnyElement> {
    let theme = cx.theme();
    let code = cx.code();
    let model = ws.model.read(cx);
    let review = model.review.as_ref()?;
    let context = review.pull.as_ref()?;
    let pull = ws.pull.read(cx);
    let detail = &context.snapshot.pull;
    let state = match (detail.state, detail.pr.draft) {
        (PullState::Merged, _) => ("merged", code.moved),
        (PullState::Closed, _) => ("closed", code.del),
        (PullState::Open, true) => ("draft", theme.muted_foreground),
        (PullState::Open, false) => ("open", code.add),
    };
    let row = |label: &'static str, value: AnyElement| {
        h_flex()
            .gap_2()
            .child(
                div()
                    .w(px(56.))
                    .flex_none()
                    .text_color(theme.muted_foreground)
                    .child(label),
            )
            .child(div().min_w_0().flex_1().child(value))
    };
    let reviewers = pull.activity.as_ref().map(|a| {
        h_flex()
            .flex_wrap()
            .gap_x_2()
            .children(a.reviewers.iter().map(|r| {
                let (icon, color) = reviewer_icon(r.state, cx);
                let name = if r.team {
                    format!("@{}/{}", context.repo.owner, r.login)
                } else {
                    r.login.clone()
                };
                h_flex()
                    .gap_0p5()
                    .child(div().text_color(color).child(icon))
                    .child(name)
            }))
            .into_any_element()
    });
    let pending = pull.pending().map(|p| {
        muted(
            format!(
                "your pending review: {} comment{} (only you see it)",
                p.comments,
                if p.comments == 1 { "" } else { "s" }
            ),
            cx,
        )
    });
    let unpushed = ducky_github::review::unpushed_notes(&review.notes).len();
    let button = |id: &'static str, label: String, keys: &'static str| {
        h_flex()
            .id(id)
            .gap_1()
            .px_1()
            .rounded(theme.radius)
            .cursor_pointer()
            .border_1()
            .border_color(theme.border)
            .hover(|this| this.bg(code.bg_2))
            .child(label)
            .child(div().text_color(code.accent).child(keys))
    };
    let chip = ci::chip(pull, cx);
    Some(
        v_flex()
            .px(code.metrics.pad_x)
            .py(code.metrics.pad_y)
            .gap_0p5()
            .border_b_1()
            .border_color(theme.border)
            .font_family(theme.mono_font_family.clone())
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        div()
                            .px_1()
                            .rounded(theme.radius)
                            .bg(state.1.opacity(0.18))
                            .text_color(state.1)
                            .child(state.0),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .font_weight(FontWeight::BOLD)
                            .child(format!("#{} {}", detail.pr.number, detail.pr.title)),
                    ),
            )
            .child(row(
                "by",
                div()
                    .child(format!(
                        "{} · {} ← {}",
                        detail.author, detail.pr.base_ref, detail.pr.head_ref
                    ))
                    .into_any_element(),
            ))
            .child(row(
                "ci",
                match chip {
                    Some((icon, text, color)) => h_flex()
                        .id("summary-ci")
                        .gap_1()
                        .cursor_pointer()
                        .text_color(color)
                        .child(icon)
                        .child(text)
                        .on_click(|_, w, cx| w.dispatch_action(Box::new(CiTab), cx))
                        .into_any_element(),
                    None => muted("checking…", cx).into_any_element(),
                },
            ))
            .children(reviewers.map(|r| row("review", r)))
            .children(pending)
            .children(context.checkout.local_off_reason().map(|reason| {
                div()
                    .text_color(theme.muted_foreground)
                    .text_size(code.metrics.text * 0.92)
                    .child(reason)
            }))
            .child(
                h_flex()
                    .pt_1()
                    .gap_1()
                    .flex_wrap()
                    .child(
                        button("push-notes", format!("push notes ({unpushed})"), "g p")
                            .on_click(|_, w, cx| w.dispatch_action(Box::new(PushNotes), cx)),
                    )
                    .child(
                        button("submit-review", "submit review".into(), "g s")
                            .on_click(|_, w, cx| w.dispatch_action(Box::new(SubmitReview), cx)),
                    )
                    .when_some(pull.writes_refused(), |this, reason| {
                        this.child(muted(reason, cx))
                    }),
            )
            .into_any_element(),
    )
}
