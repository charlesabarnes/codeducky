//! The left column: what is under review, then the files or notes tab.

use ducky_review::NoteStatus;
use ducky_review::summary::count_notes;
use gpui_kit::component::{ActiveTheme, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::state::SidebarTab;
use crate::theme::ActiveCode;
use crate::views::widgets::{counts, progress, short_rev, short_sha};
use crate::views::workspace::Workspace;
use crate::views::{files, notes_panel};

pub fn render(
    ws: &mut Workspace,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> impl IntoElement {
    let code = *cx.code();
    let theme = cx.theme().clone();
    let model = ws.model.read(cx);
    let Some(review) = model.review.as_ref() else {
        return div().into_any_element();
    };
    let (additions, deletions) = review
        .files
        .iter()
        .filter_map(|f| f.line_counts())
        .fold((0, 0), |(a, d), (fa, fd)| (a + fa, d + fd));
    let note_counts = count_notes(&review.notes);
    let open = note_counts.status(NoteStatus::Open);
    let viewed = review.viewed_count();
    let total = review.files.len();
    let tab = model.tab;

    let row = |label: &'static str, value: AnyElement| {
        h_flex()
            .gap_2()
            .child(
                div()
                    .w(px(56.))
                    .text_color(theme.muted_foreground)
                    .child(label),
            )
            .child(div().min_w_0().flex_1().child(value))
    };
    let notes_value = if note_counts.possibly_resolved > 0 {
        format!(
            "{open} open · {} possibly resolved",
            note_counts.possibly_resolved
        )
    } else {
        format!("{open} open · {} total", note_counts.total)
    };
    let summary = v_flex()
        .px(code.metrics.pad_x)
        .py(code.metrics.pad_y)
        .gap_0p5()
        .font_family(theme.mono_font_family.clone())
        .child(row(
            "branch",
            div().child(review.branch_label()).into_any_element(),
        ))
        .child(row(
            "base",
            div()
                .child(format!(
                    "{} @ {}",
                    short_rev(&review.base),
                    short_sha(&review.merge_base)
                ))
                .into_any_element(),
        ))
        .child(row(
            "diff",
            h_flex()
                .gap_2()
                .child(format!("{total} files"))
                .child(counts(additions, deletions, cx))
                .into_any_element(),
        ))
        .child(row("notes", div().child(notes_value).into_any_element()))
        .child(row(
            "viewed",
            h_flex()
                .gap_2()
                .child(progress(viewed, total, cx))
                .child(format!("{viewed}/{total}"))
                .into_any_element(),
        ));
    // Mount point: since-last-look and the commit picker (phase 5), checklists (phase 3b) and the
    // agent buttons (phase 4) go below the summary.

    let tab_button = |id: &'static str, label: String, this_tab: SidebarTab| {
        let on = tab == this_tab;
        div()
            .id(id)
            .flex_1()
            .py_1()
            .text_center()
            .cursor_pointer()
            .font_family(theme.mono_font_family.clone())
            .when(on, |this| {
                this.bg(theme.foreground).text_color(theme.background)
            })
            .when(!on, |this| this.hover(|this| this.bg(code.bg_2)))
            .child(label)
            .on_click(cx.listener(move |ws, _, _, cx| {
                ws.model.update(cx, |m, cx| {
                    m.tab = this_tab;
                    cx.notify();
                })
            }))
    };
    let tabs = h_flex()
        .border_t_1()
        .border_b_1()
        .border_color(theme.border)
        .child(tab_button(
            "tab-files",
            format!("files {total}"),
            SidebarTab::Files,
        ))
        .child(div().w(px(1.)).h_full().bg(theme.border))
        .child(tab_button(
            "tab-notes",
            format!("notes {open}"),
            SidebarTab::Notes,
        ));

    let content = match tab {
        SidebarTab::Files => files::render(ws, window, cx).into_any_element(),
        SidebarTab::Notes => notes_panel::render(ws, window, cx).into_any_element(),
    };

    v_flex()
        .id("sidebar")
        .w(code.metrics.sidebar)
        .h_full()
        .flex_none()
        .bg(theme.sidebar)
        .border_r_1()
        .border_color(theme.sidebar_border)
        .child(summary)
        .child(tabs)
        .child(div().flex_1().min_h_0().flex().flex_col().child(content))
        .into_any_element()
}
