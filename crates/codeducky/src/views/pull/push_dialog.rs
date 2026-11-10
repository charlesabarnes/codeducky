//! Push notes: each open note not yet on GitHub, where it lands on the pull request's diff (or
//! why it cannot be placed, in which case it goes in the review body). Ticked notes go into
//! your pending review; nothing is published until you submit.

use std::collections::BTreeSet;

use ducky_github::placement::{PlacedNote, UnplacedNote};
use ducky_github::review::{PushPreview, PushSelection, push_error_hint};
use ducky_github::threads::PendingReview;
use ducky_review::{Note, NoteId, Side};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::{ActiveTheme, Disableable as _, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::keymap::SubmitDialog;
use crate::state::PullModel;
use crate::theme::ActiveCode;
use crate::views::dialog::{backdrop, error_line, frame};
use crate::views::widgets::{muted, short_sha};

pub struct PushDialog {
    pull: Entity<PullModel>,
    preview: PushPreview,
    pending: Option<PendingReview>,
    selected: BTreeSet<NoteId>,
    pushing: bool,
    error: Option<String>,
    done: Option<String>,
    writes_off: Option<&'static str>,
}

impl PushDialog {
    pub fn new(
        pull: Entity<PullModel>,
        preview: PushPreview,
        pending: Option<PendingReview>,
        writes_off: Option<&'static str>,
    ) -> Self {
        let selected = preview
            .placement
            .placed
            .iter()
            .map(|p| p.note.id.clone())
            .chain(preview.placement.unplaced.iter().map(|u| u.note.id.clone()))
            .collect();
        Self {
            pull,
            preview,
            pending,
            selected,
            pushing: false,
            error: None,
            done: None,
            writes_off,
        }
    }

    pub fn toggle(&mut self, id: &NoteId, cx: &mut Context<Self>) {
        if !self.selected.remove(id) {
            self.selected.insert(id.clone());
        }
        cx.notify();
    }

    fn selection(&self) -> PushSelection {
        let picked = |note: &Note| self.selected.contains(&note.id);
        PushSelection {
            placed: self
                .preview
                .placement
                .placed
                .iter()
                .filter(|p| picked(&p.note))
                .cloned()
                .collect(),
            body_notes: self
                .preview
                .placement
                .unplaced
                .iter()
                .filter(|u| picked(&u.note))
                .map(|u| u.note.clone())
                .collect(),
        }
    }

    pub fn push(&mut self, cx: &mut Context<Self>) {
        if self.pushing || self.done.is_some() || self.selected.is_empty() {
            return;
        }
        if let Some(reason) = self.writes_off {
            self.error = Some(reason.into());
            cx.notify();
            return;
        }
        let selection = self.selection();
        let (inline, in_body) = (selection.placed.len(), selection.body_notes.len());
        let had_pending = self.pending.is_some();
        self.pushing = true;
        self.error = None;
        cx.notify();
        let dialog = cx.entity().downgrade();
        let pull = self.pull.clone();
        pull.update(cx, |pull, cx| {
            pull.push(selection, cx, move |result, cx| {
                dialog
                    .update(cx, |this, cx| {
                        this.pushing = false;
                        match result {
                            Ok(_) => {
                                this.done = Some(pushed_text(had_pending, inline, in_body));
                            }
                            Err(error) => {
                                let hint = ducky_github::GitHubError::new(
                                    ducky_github::ErrorKind::Invalid,
                                    422,
                                    error.clone(),
                                );
                                this.error =
                                    Some(push_error_hint(&hint).map_or(error, str::to_owned));
                            }
                        }
                        cx.notify();
                    })
                    .ok();
            })
        });
    }
}

fn pushed_text(had_pending: bool, inline: usize, in_body: usize) -> String {
    let plural = |n: usize, word: &str| format!("{n} {word}{}", if n == 1 { "" } else { "s" });
    let mut text = format!(
        "{} your pending review with {}",
        if had_pending { "Added to" } else { "Created" },
        plural(inline, "inline comment")
    );
    if in_body > 0 {
        text.push_str(&format!(" and {} in its body", plural(in_body, "note")));
    }
    text.push_str(". Only you see it until you submit it (g s).");
    text
}

fn placed_where(placed: &PlacedNote) -> String {
    let c = &placed.comment;
    let start = c.start_line.unwrap_or(c.line);
    let span = if start == c.line {
        c.line.to_string()
    } else {
        format!("{start}-{}", c.line)
    };
    let base = if c.side == Side::Old { " (base)" } else { "" };
    let moved = start != placed.note.anchor.line || c.line != placed.note.anchor.last_line();
    let locally = if moved {
        format!(" ({} locally)", placed.note.anchor.lines_label())
    } else {
        String::new()
    };
    format!("{}:{span}{base}{locally}", c.path)
}

fn unplaced_where(unplaced: &UnplacedNote) -> String {
    format!(
        "{}:{} · {}",
        unplaced.note.path,
        unplaced.note.anchor.line_span(),
        unplaced.reason
    )
}

impl PushDialog {
    fn row(&self, note: &Note, place: String, nearest: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let code = cx.code();
        let id = note.id.clone();
        let snippet = note.body.lines().next().unwrap_or("No text.").to_owned();
        h_flex()
            .id(SharedString::from(format!("push-{}", note.id)))
            .gap_2()
            .items_start()
            .py_0p5()
            .child(
                Checkbox::new(SharedString::from(format!("push-check-{}", note.id)))
                    .checked(self.selected.contains(&note.id))
                    .on_click(cx.listener(move |this, _, _, cx| this.toggle(&id, cx))),
            )
            .child(
                div()
                    .w(px(64.))
                    .flex_none()
                    .font_weight(FontWeight::BOLD)
                    .text_color(code.severity(note.severity))
                    .child(note.severity.as_str()),
            )
            .child(
                v_flex()
                    .min_w_0()
                    .flex_1()
                    .child(
                        h_flex()
                            .gap_2()
                            .font_family(theme.mono_font_family.clone())
                            .text_color(theme.muted_foreground)
                            .child(place)
                            .when(nearest, |this| {
                                this.child(div().text_color(code.modified).child("nearest match"))
                            }),
                    )
                    .child(div().overflow_hidden().whitespace_nowrap().child(snippet)),
            )
            .into_any_element()
    }
}

impl Render for PushDialog {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let code = *cx.code();
        let preview = self.preview.clone();
        let pr = &preview.pr;
        let placed: Vec<AnyElement> = preview
            .placement
            .placed
            .iter()
            .map(|p| self.row(&p.note, placed_where(p), !p.exact, cx))
            .collect();
        let unplaced: Vec<AnyElement> = preview
            .placement
            .unplaced
            .iter()
            .map(|u| self.row(&u.note, unplaced_where(u), false, cx))
            .collect();
        let total = placed.len() + unplaced.len();
        let section = |title: String, hint: Option<&'static str>| {
            h_flex()
                .pt_1()
                .gap_2()
                .child(div().font_weight(FontWeight::BOLD).child(title))
                .children(hint.map(|h| muted(h, cx)))
        };
        let footer_label = match (&self.done, self.pushing, &self.pending) {
            (Some(_), _, _) => "Done",
            (None, true, _) => "Pushing…",
            (None, false, Some(_)) => "Add to pending review",
            (None, false, None) => "Create pending review",
        };
        let card = frame(
            "push-notes",
            format!("Push notes to #{}", pr.number),
            680.,
            cx,
        )
        .on_action(cx.listener(|this, _: &SubmitDialog, _, cx| this.push(cx)))
        .child(
            h_flex()
                .gap_2()
                .child(muted(format!("#{}", pr.number), cx))
                .child(
                    div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(pr.title.clone()),
                )
                .when(pr.draft, |this| this.child(muted("draft", cx))),
        )
        .when_some(self.pending.as_ref(), |this, pending| {
            this.child(muted(
                format!(
                    "Adds to your pending review ({} comment{} on GitHub so far).",
                    pending.comments,
                    if pending.comments == 1 { "" } else { "s" }
                ),
                cx,
            ))
        })
        .when(preview.local_head != pr.head_sha, |this| {
            this.child(div().text_color(code.modified).child(format!(
                "Your notes were made on {}, not the pull request head {}: check where they land.",
                short_sha(&preview.local_head),
                short_sha(&pr.head_sha)
            )))
        })
        .when(total == 0, |this| {
            this.child(muted(
                "There are no open notes that are not on GitHub yet.",
                cx,
            ))
        })
        .when(!placed.is_empty(), |this| {
            this.child(section(format!("inline comments {}", placed.len()), None))
                .children(placed)
        })
        .when(!unplaced.is_empty(), |this| {
            this.child(section(
                format!("not on the diff {}", unplaced.len()),
                Some("ticked ones go in the review body, with an excerpt"),
            ))
            .children(unplaced)
        })
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
                .child(muted(
                    "The review stays pending, visible only to you, until you submit it.",
                    cx,
                ))
                .child(
                    Button::new("push-go")
                        .label(footer_label)
                        .small()
                        .primary()
                        .disabled(self.pushing || self.done.is_some() || self.selected.is_empty())
                        .on_click(cx.listener(|this, _, _, cx| this.push(cx))),
                ),
        );
        backdrop(v_flex().child(card), cx)
    }
}
