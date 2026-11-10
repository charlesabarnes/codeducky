//! The inbox: pull requests waiting on your review, yours, and ones you reviewed lately, with CI,
//! your review state and pending reviews; open one from a row or by pasting a reference.

use ducky_github::inbox::{CiRollup, InboxRow, InboxSection, InboxState, TOKEN_SCOPE_HINT};
use ducky_review::Timestamp;
use ducky_session::github::GitHubStatus;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::Input;
use gpui_kit::component::{ActiveTheme, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::keymap::{CloseInbox, GitHubSettings, RefreshInbox};
use crate::theme::ActiveCode;
use crate::views::pull::time::{age, short_age};
use crate::views::widgets::{counts, key_hint, muted};
use crate::views::workspace::Workspace;

pub fn ci_icon(ci: CiRollup) -> &'static str {
    match ci {
        CiRollup::Pass => "✓",
        CiRollup::Fail => "✕",
        CiRollup::Pending => "●",
        CiRollup::None => "○",
    }
}

pub fn ci_color(ci: CiRollup, cx: &App) -> Hsla {
    let code = cx.code();
    match ci {
        CiRollup::Pass => code.add,
        CiRollup::Fail => code.del,
        CiRollup::Pending => code.modified,
        CiRollup::None => cx.theme().muted_foreground,
    }
}

fn review_label(state: &str) -> Option<&'static str> {
    Some(match state {
        "APPROVED" => "you approved",
        "CHANGES_REQUESTED" => "you requested changes",
        "COMMENTED" => "you commented",
        "DISMISSED" => "your review was dismissed",
        _ => return None,
    })
}

/// Every row in screen order, for the keyboard cursor.
pub fn rows(inbox: &ducky_github::inbox::Inbox) -> Vec<&InboxRow> {
    InboxSection::ALL
        .iter()
        .flat_map(|s| inbox.section(*s))
        .collect()
}

fn badge(text: impl Into<SharedString>, color: Hsla, cx: &App) -> Div {
    div()
        .px_1()
        .rounded(cx.theme().radius)
        .border_1()
        .border_color(color.opacity(0.6))
        .text_color(color)
        .child(text.into())
}

pub fn render(ws: &mut Workspace, _: &mut Window, cx: &mut Context<Workspace>) -> impl IntoElement {
    let theme = cx.theme().clone();
    let code = *cx.code();
    let github = ws.github.read(cx);
    let now = Timestamp::now();
    let status = github.status.clone();
    let loading = github.is_busy();
    let inbox = github.inbox.clone();
    let error = github.inbox_error.clone();
    let cursor = github.inbox_cursor;
    let opening = ws.model.read(cx).busy.clone();

    let head = h_flex()
        .gap_3()
        .child(
            div()
                .text_size(px(18.))
                .font_weight(FontWeight::SEMIBOLD)
                .child("inbox"),
        )
        .children(github.viewer().map(|v| muted(format!("as {v}"), cx)))
        .child(div().flex_1())
        .child(muted(
            match (&inbox, loading) {
                (_, true) => "loading…".to_owned(),
                (Some(inbox), false) => format!("updated {} ago", age(inbox.fetched_at, now))
                    .replace("now ago", "just now"),
                (None, false) => String::new(),
            },
            cx,
        ))
        .child(
            Button::new("inbox-refresh")
                .label("refresh")
                .small()
                .on_click(|_, w, cx| w.dispatch_action(Box::new(RefreshInbox), cx)),
        )
        .child(
            h_flex()
                .id("inbox-close")
                .gap_1()
                .cursor_pointer()
                .child(key_hint("esc", cx))
                .child("back")
                .on_click(|_, w, cx| w.dispatch_action(Box::new(CloseInbox), cx)),
        );

    let open_form = v_flex()
        .gap_1()
        .child(
            h_flex()
                .gap_2()
                .child(div().flex_1().child(Input::new(&ws.pr_input).small()))
                .child(
                    Button::new("open-pr")
                        .label("open")
                        .small()
                        .primary()
                        .on_click(cx.listener(|ws, _, window, cx| ws.open_pr_input(window, cx))),
                ),
        )
        .children(
            ws.pr_input_error
                .clone()
                .map(|e| div().text_color(code.del).child(e)),
        )
        .children(opening.map(|text| muted(format!("{text}…"), cx)));

    let signed_out = match &status {
        GitHubStatus::SignedOut { reason } => Some(reason.clone()),
        _ => None,
    };
    let problem = signed_out.map(|reason| {
        v_flex()
            .gap_1()
            .p_3()
            .rounded(theme.radius)
            .border_1()
            .border_color(code.del.opacity(0.6))
            .child(div().text_color(code.del).child(reason))
            .child(
                h_flex()
                    .id("inbox-settings")
                    .gap_1()
                    .cursor_pointer()
                    .text_color(code.accent)
                    .child("Sign in: run `gh auth login`, or paste a token in GitHub settings")
                    .on_click(|_, w, cx| w.dispatch_action(Box::new(GitHubSettings), cx)),
            )
            .child(muted(TOKEN_SCOPE_HINT, cx))
    });
    let error_card = error.filter(|_| problem.is_none()).map(|message| {
        v_flex()
            .gap_1()
            .p_3()
            .rounded(theme.radius)
            .border_1()
            .border_color(code.del.opacity(0.6))
            .child(div().text_color(code.del).child(message))
            .when(inbox.is_some(), |this| {
                this.child(muted("Showing the inbox from before.", cx))
            })
    });
    let scope_hint = match &status {
        GitHubStatus::SignedIn {
            scope_hint: Some(hint),
            ..
        } => Some(hint.clone()),
        _ => None,
    };

    let mut index = 0usize;
    let sections = inbox.as_ref().map(|inbox| {
        let empty = rows(inbox).is_empty();
        v_flex()
            .gap_4()
            .when(empty, |this| {
                this.child(
                    v_flex()
                        .gap_1()
                        .child(format!("No pull requests found for {}.", inbox.viewer))
                        .child(muted(TOKEN_SCOPE_HINT, cx)),
                )
            })
            .children(InboxSection::ALL.iter().map(|&section| {
                let list = inbox.section(section);
                let total = inbox.total(section);
                let count = if total as usize > list.len() {
                    format!("{} of {total}", list.len())
                } else {
                    list.len().to_string()
                };
                let header_count = muted(count, cx);
                let nothing = list.is_empty().then(|| muted("Nothing here.", cx));
                let rows: Vec<AnyElement> = list
                    .iter()
                    .map(|row| {
                        let i = index;
                        index += 1;
                        row_view(row, i, i == cursor, now, cx)
                    })
                    .collect();
                v_flex()
                    .gap_1()
                    .child(
                        h_flex()
                            .gap_2()
                            .font_weight(FontWeight::BOLD)
                            .child(section.title().to_lowercase())
                            .child(header_count),
                    )
                    .children(nothing)
                    .children(rows)
            }))
    });

    div().flex_1().min_h_0().flex().justify_center().child(
        v_flex()
            .id("inbox")
            .w(px(820.))
            .max_w_full()
            .pt(px(28.))
            .pb_6()
            .px_4()
            .gap_4()
            .overflow_y_scroll()
            .child(head)
            .child(open_form)
            .children(problem)
            .children(error_card)
            .children(scope_hint.map(|hint| {
                v_flex()
                    .gap_1()
                    .p_3()
                    .rounded(theme.radius)
                    .border_1()
                    .border_color(code.modified.opacity(0.6))
                    .child(
                        div()
                            .text_color(code.modified)
                            .child("The token is missing the repo scope."),
                    )
                    .child(muted(hint, cx))
            }))
            .when(loading && inbox.is_none(), |this| {
                this.child(muted("Loading pull requests from GitHub…", cx))
            })
            .children(sections),
    )
}

fn row_view(
    row: &InboxRow,
    index: usize,
    focused: bool,
    now: Timestamp,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let theme = cx.theme().clone();
    let code = *cx.code();
    let mut badges: Vec<Div> = Vec::new();
    if row.draft {
        badges.push(badge("draft", theme.muted_foreground, cx));
    }
    match row.state {
        InboxState::Open => {}
        InboxState::Merged => badges.push(badge("merged", code.moved, cx)),
        InboxState::Closed => badges.push(badge("closed", code.del, cx)),
    }
    if row.via_team {
        badges.push(badge("team request", theme.muted_foreground, cx));
    }
    if row.pending_review {
        badges.push(badge("your review is pending", code.modified, cx));
    }
    if let Some(label) = row.my_review.as_deref().and_then(review_label) {
        let color = match row.my_review.as_deref() {
            Some("APPROVED") => code.add,
            Some("CHANGES_REQUESTED") => code.del,
            _ => theme.muted_foreground,
        };
        badges.push(badge(label, color, cx));
    }
    let (owner, name, number) = (row.owner.clone(), row.name.clone(), row.number);
    h_flex()
        .id(("inbox-row", index))
        .gap_3()
        .px_2()
        .py_1p5()
        .rounded(theme.radius)
        .cursor_pointer()
        .when(focused, |this| {
            this.bg(code.bg_2).border_l_2().border_color(code.accent)
        })
        .hover(|this| this.bg(code.bg_2))
        .child(
            div()
                .w(px(16.))
                .flex_none()
                .font_family(theme.mono_font_family.clone())
                .text_color(ci_color(row.ci, cx))
                .child(ci_icon(row.ci)),
        )
        .child(
            v_flex()
                .min_w_0()
                .flex_1()
                .gap_0p5()
                .child(
                    h_flex()
                        .gap_2()
                        .child(muted(format!("{}/{}", row.owner, row.name), cx))
                        .child(
                            div()
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(row.title.clone()),
                        )
                        .child(muted(format!("#{}", row.number), cx)),
                )
                .child(
                    h_flex()
                        .flex_wrap()
                        .gap_2()
                        .text_color(theme.muted_foreground)
                        .child(row.author.clone())
                        .child(format!("opened {} ago", short_age(&row.created_at, now)))
                        .child(format!("updated {} ago", short_age(&row.updated_at, now)))
                        .child(counts(row.additions, row.deletions, cx))
                        .child(format!(
                            "{} {}",
                            row.changed_files,
                            if row.changed_files == 1 {
                                "file"
                            } else {
                                "files"
                            }
                        ))
                        .children(badges),
                ),
        )
        .on_click(cx.listener(move |ws, _, window, cx| {
            ws.github.update(cx, |g, _| g.inbox_cursor = index);
            let repo = ducky_github::RepoRef::new(owner.clone(), name.clone());
            ws.open_pull(repo, number, false, window, cx);
        }))
        .into_any_element()
}
