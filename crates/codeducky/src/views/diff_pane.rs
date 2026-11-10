//! The selected file: its header and toggles, notices, and the diff with notes inline.

use std::collections::HashMap;
use std::rc::Rc;

use ducky_review::diff::{LineEnding, LineKind};
use ducky_review::{Note, Side};
use ducky_session::{DiffContent, FileNotice};
use gpui_kit::component::diff::{
    Diff, DiffAnnotation, DiffDecoration, DiffGutterMarker, DiffHoverHighlight, DiffLinePosition,
    DiffLineRange,
};
use gpui_kit::component::input::TextareaState;
use gpui_kit::component::{ActiveTheme, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::config::DiffMode;
use crate::keymap::{ToggleEditor, ToggleMode, ToggleViewed, ToggleWhitespace, ToggleWrap};
use crate::state::cursor::LinePos;
use crate::state::{Composer, Pane, ReviewModel};
use crate::theme::ActiveCode;
use crate::views::note_card;
use crate::views::pull::ci::annotation_card;
use crate::views::pull::inline::InlinePull;
use crate::views::pull::threads::{ThreadView, thread_card};
use crate::views::widgets::{badge_color, counts, muted, toggle};
use crate::views::workspace::{Workspace, side_from, side_of};
use ducky_github::CheckAnnotation;
use ducky_github::threads::ReviewThread;

const COMPOSER: &str = "composer";

pub fn render(ws: &mut Workspace, _: &mut Window, cx: &mut Context<Workspace>) -> impl IntoElement {
    let theme = cx.theme().clone();
    let code = *cx.code();
    let model = ws.model.read(cx);
    let Some(path) = model.selected.clone() else {
        return v_flex()
            .size_full()
            .items_center()
            .justify_center()
            .child(muted(
                if model.review.as_ref().is_some_and(|r| r.files.is_empty()) {
                    "nothing changed against the base"
                } else {
                    "select a file"
                },
                cx,
            ))
            .into_any_element();
    };
    let file = model.visible.iter().find(|f| f.path() == path);
    let viewed = model.is_viewed(&path);
    let in_final = model.final_file(&path).is_some();
    let prefs = model.prefs.clone();
    let pane = model.pane;
    let edit_blocked = model
        .current_entry()
        .map(|entry| ducky_session::editable(entry).err().map(|r| r.to_string()))
        .unwrap_or(Some("loading".into()));
    let unsaved = model.unsaved.as_deref() == Some(path.as_str());

    let (dir, name) = match path.rsplit_once('/') {
        Some((dir, name)) => (format!("{dir}/"), name.to_owned()),
        None => (String::new(), path.clone()),
    };
    let header = h_flex()
        .h(code.metrics.bar)
        .flex_none()
        .px(code.metrics.pad_x)
        .gap_3()
        .border_b_1()
        .border_color(theme.border)
        .font_family(theme.mono_font_family.clone())
        .children(file.map(|f| {
            div()
                .font_weight(FontWeight::BOLD)
                .text_color(badge_color(f.badge(), cx))
                .child(f.badge().letter())
        }))
        .child(
            h_flex()
                .min_w_0()
                .flex_1()
                .overflow_hidden()
                .whitespace_nowrap()
                .child(div().text_color(theme.muted_foreground).child(dir))
                .child(div().font_weight(FontWeight::BOLD).child(name)),
        )
        .children(
            model
                .diff
                .as_ref()
                .filter(|d| d.diff.text().is_some())
                .map(|d| {
                    let (a, del) = d.diff.counts();
                    counts(a, del, cx)
                }),
        )
        .child(
            toggle("ws", "¶ whitespace", "w", !prefs.ignore_whitespace, cx)
                .on_click(|_, w, cx| w.dispatch_action(Box::new(ToggleWhitespace), cx)),
        )
        .child(
            toggle("wrap", "wrap", "z", prefs.wrap, cx)
                .on_click(|_, w, cx| w.dispatch_action(Box::new(ToggleWrap), cx)),
        )
        .child(if in_final {
            toggle(
                "viewed",
                if viewed { "[x] viewed" } else { "[ ] viewed" },
                "v",
                viewed,
                cx,
            )
            .on_click(|_, w, cx| w.dispatch_action(Box::new(ToggleViewed), cx))
            .into_any_element()
        } else {
            muted("not in the final diff", cx).into_any_element()
        })
        .child(edit_switch(pane, edit_blocked, unsaved, cx))
        .child(
            h_flex()
                .child(
                    toggle(
                        "unified",
                        "unified",
                        "",
                        prefs.diff_mode == DiffMode::Unified,
                        cx,
                    )
                    .on_click(cx.listener(|ws, _, _, cx| ws.set_mode(DiffMode::Unified, cx))),
                )
                .child(
                    toggle(
                        "split",
                        "split",
                        "s",
                        prefs.diff_mode == DiffMode::Split,
                        cx,
                    )
                    .on_click(|_, w, cx| w.dispatch_action(Box::new(ToggleMode), cx)),
                ),
        );
    let mut notices: Vec<AnyElement> = Vec::new();
    notices.extend(crate::views::mode_notices::render(model, &path, cx));
    let mut lost: Vec<Note> = Vec::new();
    if let Some(loaded) = &model.diff {
        notices.extend(
            loaded
                .diff
                .notices
                .iter()
                .filter_map(|notice| notice_text(notice).map(|text| notice_row(text, cx))),
        );
        lost = model
            .file_notes()
            .into_iter()
            .filter(|n| n.anchor_lost)
            .collect();
    }
    let elsewhere = if model.diff.is_some() {
        model.placed_notes().elsewhere
    } else {
        Vec::new()
    };
    let weak_model = ws.model.downgrade();
    let changed = model.changed_notes.clone();
    let lost_cards = (!lost.is_empty()).then(|| {
        v_flex()
            .border_b_1()
            .border_color(theme.border)
            .bg(code.bg_2)
            .child(notice_row(
                format!(
                    "{} note(s) lost their anchor: the code they were on is gone (maybe fixed)",
                    lost.len()
                ),
                cx,
            ))
            .children(lost.iter().map(|note| {
                note_card::note_card(note, changed.contains(&note.id), weak_model.clone(), cx)
            }))
    });

    let elsewhere_cards = (!elsewhere.is_empty()).then(|| {
        let heading = if model.note_view() == ducky_review::view_notes::NoteView::All {
            "Notes on earlier commits (pick the commit to see them in place)"
        } else {
            "Notes not on this diff: base lines, lines this view does not show, or another commit"
        };
        v_flex()
            .border_b_1()
            .border_color(theme.border)
            .bg(code.bg_2)
            .child(notice_row(format!("{heading} ({})", elsewhere.len()), cx))
            .children(elsewhere.iter().map(|note| {
                note_card::note_card(note, changed.contains(&note.id), weak_model.clone(), cx)
            }))
    });

    let inline = InlinePull::for_file(ws, &path, cx);
    let pull_cards = pull_cards(ws, &inline, cx.entity().downgrade(), cx);

    if pane == Pane::Edit
        && let Some(editor) = ws.editor.clone()
    {
        return v_flex()
            .size_full()
            .child(header)
            .child(div().flex_1().min_h_0().child(editor))
            .into_any_element();
    }

    let body = match model.diff.as_ref().map(|d| &d.diff.content) {
        None => placeholder("loading…", cx),
        Some(DiffContent::Binary { old_size, new_size }) => {
            placeholder(format!("binary file {}", sizes(*old_size, *new_size)), cx)
        }
        Some(DiffContent::TooLarge { old_size, new_size }) => placeholder(
            format!("too large to diff here {}", sizes(*old_size, *new_size)),
            cx,
        ),
        Some(DiffContent::Submodule { old, new }) => placeholder(
            format!(
                "submodule {} → {}",
                old.as_deref()
                    .map_or("none", crate::views::widgets::short_sha),
                new.as_deref()
                    .map_or("none", crate::views::widgets::short_sha)
            ),
            cx,
        ),
        Some(DiffContent::Text(_))
            if model.diff.as_ref().and_then(|d| d.file.as_ref()).is_none()
                || model.diff.as_ref().is_some_and(|d| d.positions.is_empty()) =>
        {
            placeholder("no lines to show", cx)
        }
        Some(DiffContent::Text(_)) => diff_view(ws, &path, inline, cx),
    };

    v_flex()
        .size_full()
        .child(header)
        .children(notices)
        .children(lost_cards)
        .children(elsewhere_cards)
        .children(pull_cards)
        .child(div().flex_1().min_h_0().child(body))
        .into_any_element()
}

/// Threads that are not on a line of this diff, and annotations that do not fit, above it.
fn pull_cards(
    ws: &Workspace,
    inline: &InlinePull,
    workspace: WeakEntity<Workspace>,
    cx: &App,
) -> Option<AnyElement> {
    if inline.listed.is_empty() && inline.unplaced.is_empty() {
        return None;
    }
    let theme = cx.theme();
    let pull = ws.pull.read(cx);
    let pull_weak = ws.pull.downgrade();
    let cards = inline.listed.iter().map(|thread| {
        thread_card(
            ThreadView {
                thread,
                focused: pull.thread_focus.as_deref() == Some(thread.id.as_str()),
                show_where: true,
                reply: reply_for(ws, &thread.id, cx),
                writes_off: pull.writes_refused(),
            },
            pull_weak.clone(),
            workspace.clone(),
            cx,
        )
    });
    let annotations = inline.unplaced.iter().map(|u| {
        v_flex()
            .child(muted(u.reason.clone(), cx).px_2())
            .child(annotation_card(
                &u.annotation,
                inline
                    .run_names
                    .get(&u.annotation.check_run_id)
                    .map(String::as_str),
                cx,
            ))
    });
    Some(
        v_flex()
            .id("pull-cards")
            .max_h(px(260.))
            .overflow_y_scroll()
            .border_b_1()
            .border_color(theme.border)
            .bg(cx.code().bg_2)
            .when(!inline.listed.is_empty(), |this| {
                this.child(notice_row(
                    format!(
                        "Threads not on a line of this diff: outdated or on the file ({})",
                        inline.listed.len()
                    ),
                    cx,
                ))
            })
            .children(cards)
            .when(!inline.unplaced.is_empty(), |this| {
                this.child(notice_row(
                    format!("CI annotations not placed ({})", inline.unplaced.len()),
                    cx,
                ))
            })
            .children(annotations)
            .into_any_element(),
    )
}

fn reply_for(ws: &Workspace, thread: &str, cx: &App) -> Option<Entity<TextareaState>> {
    (ws.pull.read(cx).replying.as_deref() == Some(thread))
        .then(|| ws.reply_input.clone())
        .flatten()
}

fn diff_view(
    ws: &Workspace,
    path: &str,
    inline: InlinePull,
    cx: &mut Context<Workspace>,
) -> AnyElement {
    let code = *cx.code();
    let theme = cx.theme().clone();
    let model = ws.model.read(cx);
    let wrap = model.prefs.wrap;
    let notes: Vec<Note> = model
        .file_notes()
        .into_iter()
        .filter(|n| !n.anchor_lost)
        .collect();
    let composer = model.composer.clone().filter(|c| c.path == path);
    let editing = composer.as_ref().and_then(|c| c.editing.clone());

    let position =
        |side, line: u32| DiffLinePosition::new(path.to_owned(), side_of(side), line as usize);
    let mut annotations: Vec<DiffAnnotation> = notes
        .iter()
        .filter(|n| Some(&n.id) != editing.as_ref())
        .map(|n| {
            DiffAnnotation::line(
                SharedString::from(format!("note:{}", n.id)),
                position(n.anchor.side, n.anchor.last_line()),
            )
        })
        .collect();
    if let Some(c) = &composer {
        annotations.push(DiffAnnotation::line(
            COMPOSER,
            position(c.side, c.last_line()),
        ));
    }
    let mut thread_groups: HashMap<String, Vec<ReviewThread>> = HashMap::new();
    let mut thread_markers: Vec<DiffGutterMarker> = Vec::new();
    for ((side, line), threads) in inline.threads {
        let key = format!("threads:{side:?}:{line}");
        annotations.push(DiffAnnotation::line(
            SharedString::from(key.clone()),
            position(side, line),
        ));
        thread_markers.push(
            DiffGutterMarker::new(
                SharedString::from(format!("marker-{key}")),
                position(side, line),
            )
            .with_label("thread"),
        );
        thread_groups.insert(key, threads);
    }
    let mut ci_groups: HashMap<String, Vec<CheckAnnotation>> = HashMap::new();
    for (line, list) in inline.annotations {
        let key = format!("ci:{line}");
        annotations.push(DiffAnnotation::line(
            SharedString::from(key.clone()),
            position(Side::New, line),
        ));
        ci_groups.insert(key, list);
    }
    let mut decorations: Vec<DiffDecoration> = Vec::new();
    let mut markers: Vec<DiffGutterMarker> = thread_markers;
    let text = model.diff.as_ref().and_then(|d| d.diff.text());
    let mut mark_range = |side: Side, start: u32, end: u32, background: Hsla| {
        decorations.push(
            DiffDecoration::new(DiffLineRange::new(
                path.to_owned(),
                side_of(side),
                start as usize,
                end as usize,
            ))
            .with_background(background),
        );
        // A context line is drawn from its old side in unified mode; mark that side too.
        let other = match side {
            Side::Old => Side::New,
            Side::New => Side::Old,
        };
        for line in text.iter().flat_map(|t| t.lines.iter()) {
            if line.kind == LineKind::Context
                && line
                    .line_on(side)
                    .is_some_and(|n| (start..=end).contains(&n))
                && let Some(n) = line.line_on(other)
            {
                decorations.push(
                    DiffDecoration::new(DiffLineRange::new(
                        path.to_owned(),
                        side_of(other),
                        n as usize,
                        n as usize,
                    ))
                    .with_background(background),
                );
            }
        }
    };
    if let Some(c) = &composer {
        mark_range(c.side, c.line, c.last_line(), code.accent.opacity(0.14));
    }
    for note in notes.iter().filter(|n| n.is_open()) {
        mark_range(
            note.anchor.side,
            note.anchor.line,
            note.anchor.last_line(),
            code.severity(note.severity).opacity(0.12),
        );
        markers.push(
            DiffGutterMarker::new(
                SharedString::from(format!("marker:{}", note.id)),
                position(note.anchor.side, note.anchor.line),
            )
            .with_label("note"),
        );
    }
    if let Some(text) = text {
        for moved in &text.moved {
            let background = match moved.side {
                Side::Old => code.moved_del_bg,
                Side::New => code.moved_add_bg,
            };
            decorations.push(
                DiffDecoration::new(DiffLineRange::new(
                    path.to_owned(),
                    side_of(moved.side),
                    moved.start as usize,
                    moved.end as usize,
                ))
                .with_background(background),
            );
            let other = if moved.other.path == path {
                format!("moved {} line {}", direction(moved.side), moved.other.line)
            } else {
                format!(
                    "moved {} {}:{}",
                    direction(moved.side),
                    moved.other.path,
                    moved.other.line
                )
            };
            markers.push(
                DiffGutterMarker::new(
                    SharedString::from(format!("moved:{:?}:{}", moved.side, moved.start)),
                    position(moved.side, moved.start),
                )
                .with_label(other),
            );
        }
    }

    let context = Rc::new(AnnotationContext {
        notes: notes
            .into_iter()
            .map(|n| (format!("note:{}", n.id), n))
            .collect(),
        composer,
        changed: model.changed_notes.clone(),
        input: ws.note_input.clone(),
        model: ws.model.downgrade(),
        workspace: cx.entity().downgrade(),
        threads: thread_groups,
        ci: ci_groups,
        run_names: inline.run_names,
        pull: ws.pull.downgrade(),
        replying: ws
            .pull
            .read(cx)
            .replying
            .clone()
            .zip(ws.reply_input.clone()),
        thread_focus: ws.pull.read(cx).thread_focus.clone(),
        writes_off: ws.pull.read(cx).writes_refused(),
    });
    let render_context = context.clone();
    let compose_model = ws.model.downgrade();
    let click_model = ws.model.downgrade();
    let note_color = code.suggestion;
    let moved_color = code.moved;
    let mono = theme.mono_font_family.clone();

    Diff::new(&ws.diff_state)
        .header_visible(false)
        .soft_wrap(wrap)
        .hover_highlight(DiffHoverHighlight::Both)
        .annotations(annotations)
        .render_annotation(move |annotation, _, cx| render_context.render(annotation, cx))
        .decorations(decorations)
        .gutter_markers(markers)
        .render_gutter_marker(move |marker, _, _| {
            let is_note = marker.label() == "note";
            let is_thread = marker.label() == "thread";
            div()
                .id(marker.id().clone())
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .font_family(mono.clone())
                .text_color(if is_note || is_thread {
                    note_color
                } else {
                    moved_color
                })
                .child(match (is_note, is_thread) {
                    (true, _) => "✎",
                    (_, true) => "◆",
                    _ => "⇅",
                })
                .when(!is_note && !is_thread, |this| {
                    let label = marker.label().clone();
                    this.tooltip(move |window, cx| {
                        gpui_kit::component::tooltip::Tooltip::new(label.clone()).build(window, cx)
                    })
                })
        })
        .on_add_annotation(move |range, _, cx| {
            let (side, start, end) = (side_from(range.side()), range.start(), range.end());
            let end = (range.side() == range.end_side()).then_some(end as u32);
            compose_model
                .update(cx, |m, cx| m.start_compose(side, start as u32, end, cx))
                .ok();
        })
        .on_line_click(move |position, _, _, cx| {
            let at = LinePos {
                side: side_from(position.side()),
                line: position.line() as u32,
            };
            click_model.update(cx, |m, cx| m.set_cursor(at, cx)).ok();
        })
        .size_full()
        .into_any_element()
}

struct AnnotationContext {
    notes: HashMap<String, Note>,
    composer: Option<Composer>,
    changed: std::collections::HashSet<ducky_review::NoteId>,
    input: Option<Entity<TextareaState>>,
    model: WeakEntity<ReviewModel>,
    workspace: WeakEntity<Workspace>,
    threads: HashMap<String, Vec<ReviewThread>>,
    ci: HashMap<String, Vec<CheckAnnotation>>,
    run_names: HashMap<u64, String>,
    pull: WeakEntity<crate::state::PullModel>,
    replying: Option<(String, Entity<TextareaState>)>,
    thread_focus: Option<String>,
    writes_off: Option<&'static str>,
}

impl AnnotationContext {
    fn render(&self, annotation: &DiffAnnotation, cx: &App) -> AnyElement {
        let ElementId::Name(name) = annotation.id() else {
            return div().into_any_element();
        };
        if name.as_ref() == COMPOSER {
            return match (&self.composer, &self.input) {
                (Some(composer), Some(input)) => note_card::composer(
                    composer,
                    input,
                    self.model.clone(),
                    self.workspace.clone(),
                    cx,
                ),
                _ => div().into_any_element(),
            };
        }
        if let Some(threads) = self.threads.get(name.as_ref()) {
            return v_flex()
                .children(threads.iter().map(|thread| {
                    let reply = self
                        .replying
                        .as_ref()
                        .filter(|(id, _)| *id == thread.id)
                        .map(|(_, input)| input.clone());
                    thread_card(
                        ThreadView {
                            thread,
                            focused: self.thread_focus.as_deref() == Some(thread.id.as_str()),
                            show_where: false,
                            reply,
                            writes_off: self.writes_off,
                        },
                        self.pull.clone(),
                        self.workspace.clone(),
                        cx,
                    )
                }))
                .into_any_element();
        }
        if let Some(list) = self.ci.get(name.as_ref()) {
            return v_flex()
                .children(list.iter().map(|a| {
                    annotation_card(
                        a,
                        self.run_names.get(&a.check_run_id).map(String::as_str),
                        cx,
                    )
                }))
                .into_any_element();
        }
        match self.notes.get(name.as_ref()) {
            Some(note) => note_card::note_card(
                note,
                self.changed.contains(&note.id),
                self.model.clone(),
                cx,
            ),
            None => div().into_any_element(),
        }
    }
}

/// `diff | edit`, with why editing is off when it is.
fn edit_switch(pane: Pane, blocked: Option<String>, unsaved: bool, cx: &App) -> AnyElement {
    let edit_label = if unsaved { "edit ●" } else { "edit" };
    let switch = h_flex()
        .id("edit-switch")
        .child(
            toggle("pane-diff", "diff", "", pane == Pane::Diff, cx).on_click(move |_, w, cx| {
                if pane == Pane::Edit {
                    w.dispatch_action(Box::new(ToggleEditor), cx)
                }
            }),
        )
        .child(
            toggle("pane-edit", edit_label, "E", pane == Pane::Edit, cx)
                .when(blocked.is_some(), |this| {
                    this.text_color(cx.theme().muted_foreground)
                })
                .on_click(move |_, w, cx| {
                    if pane == Pane::Diff {
                        w.dispatch_action(Box::new(ToggleEditor), cx)
                    }
                }),
        );
    match blocked {
        Some(reason) => switch
            .tooltip(move |window, cx| {
                gpui_kit::component::tooltip::Tooltip::new(reason.clone()).build(window, cx)
            })
            .into_any_element(),
        None => switch.into_any_element(),
    }
}

fn direction(side: ducky_review::Side) -> &'static str {
    match side {
        ducky_review::Side::Old => "to",
        ducky_review::Side::New => "from",
    }
}

fn ending(ending: LineEnding) -> &'static str {
    match ending {
        LineEnding::Lf => "LF",
        LineEnding::CrLf => "CRLF",
        LineEnding::Mixed => "mixed",
    }
}

fn notice_text(notice: &FileNotice) -> Option<String> {
    Some(match notice {
        FileNotice::Renamed { from, similarity } => match similarity {
            Some(s) => format!("renamed from {from} ({s}% similar)"),
            None => format!("renamed from {from}"),
        },
        FileNotice::Copied { from, .. } => format!("copied from {from}"),
        FileNotice::ModeChanged { old, new } => format!("mode {old} → {new}"),
        FileNotice::LineEndings(change) => format!(
            "line endings changed from {} to {}{}",
            ending(change.from),
            ending(change.to),
            if change.only {
                " — nothing else changed"
            } else {
                ""
            }
        ),
        FileNotice::Untracked => "untracked: not added to git yet".into(),
        FileNotice::WhitespaceOnly => "only whitespace changed (w shows it)".into(),
        FileNotice::NoContentChange => return None,
    })
}

pub fn notice_row(text: impl Into<SharedString>, cx: &App) -> AnyElement {
    let code = cx.code();
    div()
        .px(code.metrics.pad_x)
        .py_0p5()
        .bg(code.gap_bg)
        .border_b_1()
        .border_color(cx.theme().border)
        .font_family(cx.theme().mono_font_family.clone())
        .child(text.into())
        .into_any_element()
}

fn placeholder(text: impl Into<SharedString>, cx: &App) -> AnyElement {
    div()
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .font_family(cx.theme().mono_font_family.clone())
        .text_color(cx.theme().muted_foreground)
        .child(text.into())
        .into_any_element()
}

fn sizes(old: Option<u64>, new: Option<u64>) -> String {
    let size = |s: Option<u64>| s.map_or("—".to_owned(), human_size);
    format!("({} → {})", size(old), size(new))
}

fn human_size(bytes: u64) -> String {
    match bytes {
        0..1024 => format!("{bytes} B"),
        1024..1_048_576 => format!("{:.1} KB", bytes as f64 / 1024.),
        _ => format!("{:.1} MB", bytes as f64 / 1_048_576.),
    }
}
