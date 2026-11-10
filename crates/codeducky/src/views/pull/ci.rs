//! CI for the pull request's head: the rollup chip, the checks tab, and annotation cards drawn
//! under the line they point at.

use std::collections::HashSet;

use ducky_github::ci::{CiState, RunState, group_annotations, run_state, status_state};
use ducky_github::{AnnotationLevel, CheckAnnotation};
use gpui_kit::component::{ActiveTheme, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::state::PullModel;
use crate::theme::ActiveCode;
use crate::views::widgets::muted;
use crate::views::workspace::Workspace;

/// `(icon, text, color)` for the title bar and summary; `None` before anything loaded.
pub fn chip(pull: &PullModel, cx: &App) -> Option<(&'static str, String, Hsla)> {
    let code = cx.code();
    let muted = cx.theme().muted_foreground;
    if let Some(error) = &pull.ci_error {
        let _ = error;
        return Some(("○", "checks unavailable".into(), muted));
    }
    let ci = pull.ci.as_ref()?;
    let summary = ci.summary();
    Some(match summary.state {
        CiState::Fail => ("✕", format!("{} failing", summary.failed), code.del),
        CiState::Pending => ("●", format!("{} running", summary.pending), code.modified),
        CiState::Pass => ("✓", format!("{} passed", summary.passed), code.add),
        CiState::None => ("○", "no checks".into(), muted),
    })
}

fn run_icon(state: RunState, cx: &App) -> (&'static str, Hsla) {
    let code = cx.code();
    match state {
        RunState::Pass => ("✓", code.add),
        RunState::Fail => ("✕", code.del),
        RunState::Pending => ("●", code.modified),
        RunState::Skipped => ("–", cx.theme().muted_foreground),
    }
}

fn level(level: AnnotationLevel, cx: &App) -> (&'static str, Hsla) {
    let code = cx.code();
    match level {
        AnnotationLevel::Failure => ("failure", code.del),
        AnnotationLevel::Warning => ("warning", code.modified),
        _ => ("notice", code.moved),
    }
}

pub fn annotation_card(annotation: &CheckAnnotation, run: Option<&str>, cx: &App) -> AnyElement {
    let theme = cx.theme();
    let code = cx.code();
    let (label, color) = level(annotation.level, cx);
    v_flex()
        .my_1()
        .mx_2()
        .max_w(px(760.))
        .overflow_hidden()
        .border_1()
        .border_l_4()
        .border_color(color.opacity(0.8))
        .rounded(theme.radius)
        .bg(theme.background)
        .child(
            h_flex()
                .px_2()
                .py_0p5()
                .gap_2()
                .bg(code.bg_2)
                .font_family(theme.mono_font_family.clone())
                .child(
                    div()
                        .font_weight(FontWeight::BOLD)
                        .text_color(color)
                        .child(label),
                )
                .children(run.map(|name| muted(format!("check: {name}"), cx)))
                .children(annotation.title.clone().map(|t| {
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .child(t)
                }))
                .child(div().flex_1())
                .child(div().flex_none().child(muted(
                    if annotation.end_line > annotation.start_line {
                        format!("lines {}–{}", annotation.start_line, annotation.end_line)
                    } else {
                        format!("line {}", annotation.start_line)
                    },
                    cx,
                ))),
        )
        .child(
            div()
                .px_2()
                .py_1()
                .font_family(theme.mono_font_family.clone())
                .child(annotation.message.clone()),
        )
        .into_any_element()
}

/// The CI tab: every check run and status, then annotations on files the pull request does not
/// change.
pub fn render_tab(ws: &mut Workspace, cx: &mut Context<Workspace>) -> AnyElement {
    let theme = cx.theme().clone();
    let pull = ws.pull.read(cx);
    let chip = chip(pull, cx);
    let Some(ci) = pull.ci.clone() else {
        let text = match &pull.ci_error {
            Some(error) => error.clone(),
            None if pull.context().is_some() => "loading checks…".into(),
            None => "CI shows for pull requests".into(),
        };
        return muted(text, cx).p_2().into_any_element();
    };
    let polling = pull.ci_pending();
    let files: HashSet<&str> = ws
        .model
        .read(cx)
        .review
        .as_ref()
        .map(|r| r.files.iter().map(|f| f.path()).collect())
        .unwrap_or_default();
    let elsewhere = group_annotations(&ci.annotations, &files).elsewhere;
    let row = |id: String, icon: (&'static str, Hsla), name: String, detail: String| {
        h_flex()
            .id(SharedString::from(id))
            .gap_2()
            .px_2()
            .py_0p5()
            .font_family(theme.mono_font_family.clone())
            .child(div().w(px(14.)).text_color(icon.1).child(icon.0))
            .child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .child(name),
            )
            .child(muted(detail, cx))
    };
    let runs = ci.runs.iter().map(|run| {
        let state = run_state(run);
        let detail = match (&run.conclusion, state) {
            (Some(c), _) => format!("{c:?}").to_lowercase(),
            (None, RunState::Pending) => "running".into(),
            _ => String::new(),
        };
        let detail = if run.annotations_count > 0 {
            format!("{detail} · {} annotations", run.annotations_count)
        } else {
            detail
        };
        row(
            format!("run-{}", run.id),
            run_icon(state, cx),
            run.name.clone(),
            detail,
        )
    });
    let statuses = ci.statuses.iter().map(|status| {
        row(
            format!("status-{}", status.context),
            run_icon(status_state(status), cx),
            status.context.clone(),
            status.description.clone().unwrap_or_default(),
        )
    });
    let run_name = |id: u64| ci.runs.iter().find(|r| r.id == id).map(|r| r.name.clone());
    v_flex()
        .id("ci-tab")
        .size_full()
        .overflow_y_scroll()
        .py_1()
        .children(chip.map(|(icon, text, color)| {
            h_flex()
                .px_2()
                .pb_1()
                .gap_2()
                .text_color(color)
                .font_weight(FontWeight::BOLD)
                .child(icon)
                .child(text)
                .when(polling, |this| this.child(muted("checking again soon", cx)))
        }))
        .children(runs)
        .children(statuses)
        .when(!elsewhere.is_empty(), |this| {
            this.child(
                div()
                    .px_2()
                    .pt_2()
                    .font_weight(FontWeight::BOLD)
                    .child(format!("annotations elsewhere ({})", elsewhere.len())),
            )
            .children(elsewhere.iter().map(|a| {
                v_flex()
                    .child(muted(a.path.clone(), cx).px_2())
                    .child(annotation_card(a, run_name(a.check_run_id).as_deref(), cx))
            }))
        })
        .into_any_element()
}
