//! Every note of the review, filtered by status; click one to jump to it.

use ducky_review::summary::{StatusFilter, count_notes};
use ducky_review::{NoteStatus, Side};
use gpui_kit::component::{ActiveTheme, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::theme::ActiveCode;
use crate::views::workspace::Workspace;

const FILTERS: [(&str, StatusFilter); 4] = [
    ("all", StatusFilter::All),
    ("open", StatusFilter::Active),
    ("resolved", StatusFilter::Status(NoteStatus::Resolved)),
    ("possibly resolved", StatusFilter::PossiblyResolved),
];

pub fn render(ws: &mut Workspace, _: &mut Window, cx: &mut Context<Workspace>) -> impl IntoElement {
    let theme = cx.theme().clone();
    let code = *cx.code();
    let model = ws.model.read(cx);
    let Some(review) = model.review.as_ref() else {
        return v_flex();
    };
    let counts = count_notes(&review.notes);
    let current = model.notes_filter;
    let chip_count = |filter: StatusFilter| match filter {
        StatusFilter::All => counts.total,
        StatusFilter::Active => counts.status(NoteStatus::Open),
        StatusFilter::Status(status) => counts.status(status),
        StatusFilter::PossiblyResolved => counts.possibly_resolved,
    };
    let chips = h_flex()
        .flex_wrap()
        .gap_1()
        .px(code.metrics.pad_x)
        .py_1()
        .children(FILTERS.iter().enumerate().map(|(i, (label, filter))| {
            let filter = *filter;
            let on = filter == current;
            div()
                .id(("note-filter", i))
                .px_1p5()
                .rounded(theme.radius)
                .cursor_pointer()
                .border_1()
                .border_color(theme.border)
                .when(on, |this| {
                    this.bg(theme.foreground).text_color(theme.background)
                })
                .child(format!("{label} {}", chip_count(filter)))
                .on_click(cx.listener(move |ws, _, _, cx| {
                    ws.model.update(cx, |m, cx| {
                        m.notes_filter = filter;
                        cx.notify();
                    })
                }))
        }));

    let rows = model.notes_list().into_iter().map(|note| {
        let id = note.id.clone();
        let side = match note.anchor.side {
            Side::Old => " (base)",
            Side::New => "",
        };
        let status = if note.possibly_resolved() {
            "possibly resolved"
        } else {
            note.status.as_str()
        };
        let first_line = note.body.lines().next().unwrap_or_default().to_owned();
        v_flex()
            .id(SharedString::from(format!("note-row-{}", note.id)))
            .px(code.metrics.pad_x)
            .py_1()
            .gap_0p5()
            .border_b_1()
            .border_color(theme.border)
            .cursor_pointer()
            .hover(|this| this.bg(code.bg_2))
            .child(
                h_flex()
                    .gap_1p5()
                    .font_family(theme.mono_font_family.clone())
                    .child(
                        div()
                            .size(px(7.))
                            .rounded_full()
                            .bg(code.severity(note.severity)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .whitespace_nowrap()
                            .child(format!("{}:{}{side}", note.path, note.anchor.line_span())),
                    )
                    .child(
                        div()
                            .text_color(if note.anchor_lost {
                                code.modified
                            } else {
                                theme.muted_foreground
                            })
                            .child(status),
                    ),
            )
            .child(
                h_flex()
                    .gap_1()
                    .text_color(theme.muted_foreground)
                    .child(note.severity.as_str())
                    .when(note.author.is_agent(), |this| {
                        this.child(format!("· by {}", note.author.label()))
                    }),
            )
            .child(
                div()
                    .whitespace_nowrap()
                    .overflow_hidden()
                    .text_ellipsis()
                    .when(!note.is_open(), |this| {
                        this.text_color(theme.muted_foreground)
                    })
                    .child(first_line),
            )
            .on_click(cx.listener(move |ws, _, _, cx| {
                let id = id.clone();
                ws.model.update(cx, |m, cx| m.jump_to_note(&id, cx));
            }))
    });
    let empty = model.notes_list().is_empty();
    v_flex().size_full().child(chips).child(
        v_flex()
            .id("notes-list")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .children(rows)
            .when(empty, |this| {
                this.child(
                    div()
                        .px(code.metrics.pad_x)
                        .py_2()
                        .text_color(theme.muted_foreground)
                        .child("no notes here — press c on a line to add one"),
                )
            }),
    )
}
