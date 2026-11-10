//! The left column: what is under review, then the files or notes tab.

use ducky_review::NoteStatus;
use ducky_review::summary::count_notes;
use gpui_kit::component::{ActiveTheme, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::keymap::{AGENTS_KEYS, AskFix, AskMessage, AskReview, ToggleAgents};
use crate::state::SidebarTab;
use crate::theme::ActiveCode;
use crate::views::widgets::{counts, progress, short_rev, short_sha};
use crate::views::workspace::Workspace;
use crate::views::{checklists, files, modes, notes_panel};

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
    let listed = model.visible.len();
    let tab = model.tab;
    let checks = model.checklists.progress(&review.state);
    let is_pull = review.pull.is_some();
    let open_threads = ws
        .pull
        .read(cx)
        .threads()
        .iter()
        .filter(|t| !t.is_resolved)
        .count();
    let ci_icon = crate::views::pull::ci::chip(ws.pull.read(cx), cx).map(|c| c.0);
    let pull_summary = crate::views::pull::summary::render(ws, cx);

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
        .when(!is_pull, |this| {
            this.child(row(
                "branch",
                div().child(review.branch_label()).into_any_element(),
            ))
        })
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
        ))
        .when(checks.total > 0, |this| {
            this.child(row(
                "checks",
                h_flex()
                    .gap_2()
                    .child(progress(checks.ticked, checks.total, cx))
                    .child(format!("{}/{}", checks.ticked, checks.total))
                    .when(checks.required_open > 0, |this| {
                        this.child(
                            div()
                                .text_color(code.del)
                                .child(format!("{} required open", checks.required_open)),
                        )
                    })
                    .into_any_element(),
            ))
        });
    let modes = modes::render(ws, cx);
    let agents = ws.agents.read(cx);
    let live = agents.agents.iter().filter(|a| a.is_live()).count();
    let working = agents
        .agents
        .iter()
        .filter(|a| a.status == ducky_agents::AgentStatus::Working)
        .count();
    let needs_core = matches!(agents.line, crate::state::agents::Line::NeedsCore { .. });
    let agents_label = match (live, working) {
        _ if needs_core => "agents: need herdr-core".to_owned(),
        (0, _) => "agents: none here".to_owned(),
        (n, 0) => format!("agents: {n}"),
        (n, w) => format!("agents: {n}, {w} working"),
    };
    let agent_button = |id: &'static str, label: &'static str, keys: &'static str| {
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
    let agent_bar = v_flex()
        .px(code.metrics.pad_x)
        .pb(code.metrics.pad_y)
        .gap_1()
        .font_family(theme.mono_font_family.clone())
        .child(
            h_flex()
                .id("agents-toggle")
                .gap_1()
                .cursor_pointer()
                .text_color(theme.muted_foreground)
                .child(agents_label)
                .child(div().flex_1())
                .child(div().text_color(code.accent).child(AGENTS_KEYS))
                .on_click(|_, w, cx| w.dispatch_action(Box::new(ToggleAgents), cx)),
        )
        .child(
            h_flex()
                .flex_wrap()
                .gap_1()
                .child(
                    agent_button("side-review", "review", "a r")
                        .on_click(|_, w, cx| w.dispatch_action(Box::new(AskReview), cx)),
                )
                .child(
                    agent_button("side-fix", "fix notes", "a f")
                        .on_click(|_, w, cx| w.dispatch_action(Box::new(AskFix), cx)),
                )
                .child(
                    agent_button("side-message", "message", "a m")
                        .on_click(|_, w, cx| w.dispatch_action(Box::new(AskMessage), cx)),
                ),
        );

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
            format!("files {listed}"),
            SidebarTab::Files,
        ))
        .child(div().w(px(1.)).h_full().bg(theme.border))
        .child(tab_button(
            "tab-notes",
            format!("notes {open}"),
            SidebarTab::Notes,
        ))
        .when(is_pull, |this| {
            this.child(div().w(px(1.)).h_full().bg(theme.border))
                .child(tab_button(
                    "tab-threads",
                    format!("threads {open_threads}"),
                    SidebarTab::Threads,
                ))
                .child(div().w(px(1.)).h_full().bg(theme.border))
                .child(tab_button(
                    "tab-ci",
                    format!("ci {}", ci_icon.unwrap_or("…")),
                    SidebarTab::Ci,
                ))
        })
        .child(div().w(px(1.)).h_full().bg(theme.border))
        .child(tab_button(
            "tab-checks",
            if checks.total > 0 {
                format!("checks {}/{}", checks.ticked, checks.total)
            } else {
                "checks".to_owned()
            },
            SidebarTab::Checks,
        ));

    let content = match tab {
        SidebarTab::Files => files::render(ws, window, cx).into_any_element(),
        SidebarTab::Notes => notes_panel::render(ws, window, cx).into_any_element(),
        SidebarTab::Checks => checklists::render(ws, window, cx).into_any_element(),
        SidebarTab::Threads => crate::views::pull::threads::render_tab(ws, cx),
        SidebarTab::Ci => crate::views::pull::ci::render_tab(ws, cx),
    };

    v_flex()
        .id("sidebar")
        .w(code.metrics.sidebar)
        .h_full()
        .flex_none()
        .bg(theme.sidebar)
        .border_r_1()
        .border_color(theme.sidebar_border)
        .children(pull_summary)
        .child(summary)
        .child(modes)
        .child(agent_bar)
        .child(tabs)
        .child(div().flex_1().min_h_0().flex().flex_col().child(content))
        .into_any_element()
}
