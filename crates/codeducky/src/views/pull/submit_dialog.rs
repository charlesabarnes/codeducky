//! Submit your review: comment, approve or request changes, with a summary. Unpushed notes go
//! along (inline where they place, in the body where they do not). GitHub's body rule and its
//! no-approving-your-own-PR rule are checked first; required checklists left open are warned
//! about, not enforced.

use ducky_github::ReviewEvent;
use ducky_github::placement::Placement;
use ducky_github::review::{SubmitInput, needs_body, review_summary, unpushed_notes};
use ducky_github::threads::PendingReview;
use ducky_review::Note;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::{Textarea, TextareaState};
use gpui_kit::component::{ActiveTheme, Disableable as _, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::keymap::SubmitDialog;
use crate::state::PullModel;
use crate::theme::ActiveCode;
use crate::views::dialog::{backdrop, chip, error_line, frame};
use crate::views::widgets::muted;

const EVENTS: [(ReviewEvent, &str); 3] = [
    (ReviewEvent::Comment, "General feedback without approving."),
    (ReviewEvent::Approve, "Approve merging these changes."),
    (
        ReviewEvent::RequestChanges,
        "Feedback that must be addressed before merging.",
    ),
];

pub struct SubmitParts {
    pub number: u64,
    pub title: String,
    pub notes: Vec<Note>,
    pub placement: Placement,
    pub pending: Option<PendingReview>,
    pub own_pull: bool,
    /// Required checklist items still open.
    pub required_open: usize,
    pub writes_off: Option<&'static str>,
}

pub struct SubmitReviewDialog {
    pull: Entity<PullModel>,
    parts: SubmitParts,
    pub event: ReviewEvent,
    pub body: Entity<TextareaState>,
    include: bool,
    busy: bool,
    error: Option<String>,
    done: Option<String>,
}

impl SubmitReviewDialog {
    pub fn new(
        pull: Entity<PullModel>,
        parts: SubmitParts,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let default = [
            review_summary(&parts.notes),
            parts
                .pending
                .as_ref()
                .map(|p| p.body.trim().to_owned())
                .unwrap_or_default(),
        ]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
        let body = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(6, 14)
                .placeholder("Summary (Markdown)")
                .default_value(default)
        });
        body.update(cx, |input, cx| input.focus(window, cx));
        Self {
            pull,
            parts,
            event: ReviewEvent::Comment,
            body,
            include: true,
            busy: false,
            error: None,
            done: None,
        }
    }

    fn unpushed(&self) -> usize {
        unpushed_notes(&self.parts.notes).len()
    }

    fn input(&self, cx: &App) -> SubmitInput {
        SubmitInput {
            event: self.event,
            body: self.body.read(cx).value().to_string(),
            placement: (self.include && self.unpushed() > 0).then(|| self.parts.placement.clone()),
        }
    }

    fn blocked(&self, cx: &App) -> Option<&'static str> {
        if self.parts.own_pull && self.event != ReviewEvent::Comment {
            return Some("GitHub does not allow this on your own pull request.");
        }
        let pending = self
            .parts
            .pending
            .as_ref()
            .map_or(0, |p| p.comments as usize);
        needs_body(&self.input(cx), pending)
            .then_some("GitHub needs a summary or at least one comment for this review.")
    }

    pub fn set_event(&mut self, event: ReviewEvent, cx: &mut Context<Self>) {
        self.event = event;
        cx.notify();
    }

    pub fn submit(&mut self, cx: &mut Context<Self>) {
        if self.busy || self.done.is_some() || self.blocked(cx).is_some() {
            return;
        }
        if let Some(reason) = self.parts.writes_off {
            self.error = Some(reason.into());
            cx.notify();
            return;
        }
        let input = self.input(cx);
        self.busy = true;
        self.error = None;
        cx.notify();
        let dialog = cx.entity().downgrade();
        let pull = self.pull.clone();
        pull.update(cx, |pull, cx| {
            pull.submit(input, cx, move |result, cx| {
                dialog
                    .update(cx, |this, cx| {
                        this.busy = false;
                        match result {
                            Ok(result) => {
                                this.done = Some(format!(
                                    "Submitted: {} with {} inline comment{}.",
                                    result.state.to_lowercase().replace('_', " "),
                                    result.comments,
                                    if result.comments == 1 { "" } else { "s" }
                                ))
                            }
                            Err(error) => this.error = Some(error),
                        }
                        cx.notify();
                    })
                    .ok();
            })
        });
    }
}

impl Render for SubmitReviewDialog {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let code = *cx.code();
        let theme = cx.theme().clone();
        let blocked = self.blocked(cx);
        let unpushed = self.unpushed();
        let placement = &self.parts.placement;
        let events = EVENTS.iter().map(|&(event, hint)| {
            let off = self.parts.own_pull && event != ReviewEvent::Comment;
            h_flex()
                .gap_2()
                .child(
                    chip(
                        SharedString::from(format!("event-{}", event.as_str())),
                        event.label(),
                        self.event == event,
                        cx,
                    )
                    .when(off, |this| this.opacity(0.5))
                    .on_click(cx.listener(move |this, _, _, cx| this.set_event(event, cx))),
                )
                .child(muted(
                    if off {
                        "GitHub does not allow this on your own pull request."
                    } else {
                        hint
                    },
                    cx,
                ))
        });
        let include_label = format!(
            "Include {unpushed} unpushed note{}: {} inline{}",
            if unpushed == 1 { "" } else { "s" },
            placement.placed.len(),
            if placement.unplaced.is_empty() {
                String::new()
            } else {
                format!(
                    ", {} in the summary (not on the diff)",
                    placement.unplaced.len()
                )
            }
        );
        let button_label = match (&self.done, self.busy) {
            (Some(_), _) => "Done".to_owned(),
            (None, true) => "Submitting…".to_owned(),
            (None, false) => format!("Submit: {}", self.event.label().to_lowercase()),
        };
        let card = frame(
            "submit-review",
            format!(
                "Submit review on #{} {}",
                self.parts.number, self.parts.title
            ),
            680.,
            cx,
        )
        .on_action(cx.listener(|this, _: &SubmitDialog, _, cx| this.submit(cx)))
        .when_some(self.parts.pending.as_ref(), |this, pending| {
            this.child(muted(
                format!(
                    "Submits your pending review ({} comment{} on GitHub).",
                    pending.comments,
                    if pending.comments == 1 { "" } else { "s" }
                ),
                cx,
            ))
        })
        .when(self.parts.required_open > 0, |this| {
            this.child(
                div()
                    .p_2()
                    .rounded(theme.radius)
                    .border_1()
                    .border_color(code.modified.opacity(0.7))
                    .text_color(code.modified)
                    .child(format!(
                        "{} required checklist item{} still open (g c). You can submit anyway.",
                        self.parts.required_open,
                        if self.parts.required_open == 1 {
                            " is"
                        } else {
                            "s are"
                        }
                    )),
            )
        })
        .child(v_flex().gap_1().children(events))
        .child(
            v_flex()
                .gap_1()
                .child(muted("summary", cx))
                .child(Textarea::new(&self.body))
                .child(muted(
                    "Defaults to a summary of your open notes. Markdown.",
                    cx,
                )),
        )
        .when(unpushed > 0, |this| {
            this.child(
                Checkbox::new("submit-include")
                    .checked(self.include)
                    .label(include_label)
                    .on_click(cx.listener(|this, checked: &bool, _, cx| {
                        this.include = *checked;
                        cx.notify();
                    })),
            )
        })
        .children(blocked.map(|b| muted(b, cx)))
        .children(
            self.done
                .clone()
                .map(|d| div().text_color(code.add).child(d)),
        )
        .children(error_line(self.error.as_deref(), cx))
        .child(
            h_flex()
                .gap_2()
                .justify_end()
                .child(muted("Since last look starts again from this head.", cx))
                .child(
                    Button::new("submit-go")
                        .label(button_label)
                        .small()
                        .primary()
                        .disabled(self.busy || self.done.is_some() || blocked.is_some())
                        .on_click(cx.listener(|this, _, _, cx| this.submit(cx))),
                ),
        );
        backdrop(v_flex().child(card), cx)
    }
}
