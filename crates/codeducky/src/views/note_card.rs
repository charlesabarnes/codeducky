//! A note as the diff shows it under its line, and the editor that writes one.

use ducky_review::{Note, NoteStatus, Severity};
use gpui_kit::component::input::{Textarea, TextareaState};
use gpui_kit::component::text::TextView;
use gpui_kit::component::{ActiveTheme, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::keymap::{CancelNote, NOTE_EDITOR, SaveNote};
use crate::state::{Composer, NoteAction, ReviewModel};
use crate::theme::ActiveCode;
use crate::views::workspace::Workspace;

fn action(
    id: SharedString,
    label: &'static str,
    keys: &'static str,
    cx: &App,
    on_click: impl Fn(&mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let code = cx.code();
    div()
        .id(id)
        .flex()
        .gap_1()
        .px_1()
        .rounded(cx.theme().radius)
        .cursor_pointer()
        .hover(|this| this.bg(code.bg_3))
        .child(label)
        .when(!keys.is_empty(), |this| {
            this.child(div().text_color(code.accent).child(keys))
        })
        .on_click(move |_, window, cx| on_click(window, cx))
}

/// A small accent dot and word: changed since the last reload.
pub fn changed_mark(cx: &App) -> Div {
    let code = cx.code();
    h_flex()
        .gap_1()
        .text_color(code.accent)
        .child(div().size(px(6.)).rounded_full().bg(code.accent))
        .child("changed")
}

fn card_shell(severity: Severity, dim: bool, cx: &App) -> Div {
    let theme = cx.theme();
    let code = cx.code();
    v_flex()
        .my_1()
        .mx_2()
        .max_w(px(760.))
        .border_1()
        .border_color(code.severity(severity).opacity(0.7))
        .rounded(theme.radius)
        .bg(theme.background)
        .when(dim, |this| this.opacity(0.75))
}

/// `changed`: the last reload found it new or changed (an agent's work), marked until visited.
pub fn note_card(
    note: &Note,
    changed: bool,
    model: WeakEntity<ReviewModel>,
    cx: &App,
) -> AnyElement {
    let theme = cx.theme();
    let code = cx.code();
    let id = note.id.clone();
    let status_label = if note.possibly_resolved() {
        "possibly resolved".to_owned()
    } else {
        note.status.as_str().to_owned()
    };
    let key = |suffix: &str| SharedString::from(format!("{}-{suffix}", note.id));
    let on = |action: NoteAction| {
        let model = model.clone();
        let id = id.clone();
        move |_: &mut Window, cx: &mut App| {
            model
                .update(cx, |m, cx| m.note_action(id.clone(), action, cx))
                .ok();
        }
    };
    let edit = {
        let model = model.clone();
        let id = id.clone();
        move |_: &mut Window, cx: &mut App| {
            model.update(cx, |m, cx| m.start_edit(&id, cx)).ok();
        }
    };
    let open = note.is_open();
    let header = h_flex()
        .px_2()
        .py_0p5()
        .gap_2()
        .border_b_1()
        .border_color(theme.border)
        .bg(code.bg_2)
        .font_family(theme.mono_font_family.clone())
        .child(
            div()
                .font_weight(FontWeight::BOLD)
                .text_color(code.severity(note.severity))
                .child(note.severity.as_str()),
        )
        .child(
            div()
                .text_color(theme.muted_foreground)
                .child(note.anchor.lines_label()),
        )
        .children(note.commit.as_deref().map(|sha| {
            div()
                .text_color(theme.muted_foreground)
                .child(format!("on commit {}", &sha[..sha.len().min(7)]))
        }))
        .when(note.author.is_agent(), |this| {
            this.child(
                div()
                    .text_color(code.moved)
                    .child(format!("by {}", note.author.label())),
            )
        })
        .when(!open || note.anchor_lost, |this| {
            this.child(
                div()
                    .px_1()
                    .rounded(theme.radius)
                    .bg(code.bg_3)
                    .child(status_label),
            )
        })
        .when(note.github.is_some(), |this| {
            this.child(div().text_color(code.moved).child("on GitHub"))
        })
        .when(changed, |this| this.child(changed_mark(cx)))
        .child(div().flex_1())
        .child(action(key("edit"), "edit", "e", cx, edit))
        .child(action(
            key("resolve"),
            if open { "resolve" } else { "reopen" },
            "r",
            cx,
            on(NoteAction::ResolveOrReopen),
        ))
        .when(open, |this| {
            this.child(action(
                key("dismiss"),
                "dismiss",
                "d",
                cx,
                on(NoteAction::Dismiss),
            ))
        })
        .child(action(
            key("delete"),
            "delete",
            "",
            cx,
            on(NoteAction::Delete),
        ));

    let resolution = note.resolution.as_ref().map(|resolution| {
        let verb = match note.status {
            NoteStatus::Dismissed => "dismissed",
            _ => "resolved",
        };
        let text = if resolution.text.is_empty() {
            format!("{verb} by {}", resolution.by.label())
        } else {
            format!("{verb} by {}: {}", resolution.by.label(), resolution.text)
        };
        div()
            .px_2()
            .py_1()
            .border_t_1()
            .border_color(theme.border)
            .text_color(theme.muted_foreground)
            .child(text)
    });

    card_shell(note.severity, !open, cx)
        .id(SharedString::from(format!("note-{}", note.id)))
        .child(header)
        .child(
            div()
                .px_2()
                .py_1()
                .child(TextView::markdown(key("body"), note.body.clone()).selectable(true)),
        )
        .children(resolution)
        .into_any_element()
}

pub fn composer(
    composer: &Composer,
    input: &Entity<TextareaState>,
    model: WeakEntity<ReviewModel>,
    workspace: WeakEntity<Workspace>,
    cx: &App,
) -> AnyElement {
    let theme = cx.theme();
    let code = cx.code();
    let current = composer.severity;
    let severities = Severity::ALL.iter().map(|&severity| {
        let model = model.clone();
        let on = severity == current;
        div()
            .id(SharedString::from(format!(
                "severity-{}",
                severity.as_str()
            )))
            .px_1p5()
            .rounded(theme.radius)
            .cursor_pointer()
            .border_1()
            .border_color(if on {
                code.severity(severity)
            } else {
                theme.border
            })
            .text_color(code.severity(severity))
            .when(on, |this| this.bg(code.bg_3).font_weight(FontWeight::BOLD))
            .child(severity.as_str())
            .on_click(move |_, _, cx| {
                model
                    .update(cx, |m, cx| m.set_composer_severity(severity, cx))
                    .ok();
            })
    });
    let save = {
        let workspace = workspace.clone();
        move |window: &mut Window, cx: &mut App| {
            workspace.update(cx, |ws, cx| ws.save_note(window, cx)).ok();
        }
    };
    let cancel = {
        let workspace = workspace.clone();
        move |window: &mut Window, cx: &mut App| {
            workspace
                .update(cx, |ws, cx| ws.cancel_note(window, cx))
                .ok();
        }
    };
    let title = match &composer.editing {
        Some(_) => format!("edit note · {}", line_span(composer)),
        None => format!("new note · {}", line_span(composer)),
    };
    let on_save = {
        let workspace = workspace.clone();
        move |_: &SaveNote, window: &mut Window, cx: &mut App| {
            workspace.update(cx, |ws, cx| ws.save_note(window, cx)).ok();
        }
    };
    let on_cancel = move |_: &CancelNote, window: &mut Window, cx: &mut App| {
        workspace
            .update(cx, |ws, cx| ws.cancel_note(window, cx))
            .ok();
    };
    card_shell(current, false, cx)
        .id("composer")
        .key_context(NOTE_EDITOR)
        .on_action(on_save)
        .on_action(on_cancel)
        .child(
            h_flex()
                .px_2()
                .py_0p5()
                .gap_2()
                .bg(code.bg_2)
                .border_b_1()
                .border_color(theme.border)
                .font_family(theme.mono_font_family.clone())
                .child(div().text_color(theme.muted_foreground).child(title))
                .child(div().flex_1())
                .children(severities),
        )
        .child(div().p_1().child(Textarea::new(input)))
        .child(
            h_flex()
                .px_2()
                .pb_1()
                .gap_2()
                .font_family(theme.mono_font_family.clone())
                .child(
                    div()
                        .flex_1()
                        .text_color(theme.muted_foreground)
                        .child("Markdown"),
                )
                .child(action(
                    "composer-cancel".into(),
                    "cancel",
                    "esc",
                    cx,
                    cancel,
                ))
                .child(action(
                    "composer-save".into(),
                    "save",
                    crate::keymap::SAVE_KEYS,
                    cx,
                    save,
                )),
        )
        .into_any_element()
}

fn line_span(composer: &Composer) -> String {
    let side = match composer.side {
        ducky_review::Side::Old => " (base)",
        ducky_review::Side::New => "",
    };
    match composer.end_line {
        Some(end) => format!("lines {}–{end}{side}", composer.line),
        None => format!("line {}{side}", composer.line),
    }
}
