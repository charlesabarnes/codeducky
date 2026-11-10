//! The changed-files list: a folder tree (or a flat risk-ordered list), filter, order toggle.

use std::rc::Rc;

use ducky_review::last_look::SinceKind;
use ducky_review::order::FileOrder;
use ducky_session::{FileBadge, TreeEntry};
use gpui_kit::component::input::Input;
use gpui_kit::component::{ActiveTheme, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::keymap::ToggleOrder;
use crate::theme::ActiveCode;
use crate::views::widgets::{badge_color, counts, key_hint};
use crate::views::workspace::Workspace;

#[derive(Clone)]
enum Row {
    Folder {
        depth: usize,
        path: String,
        name: String,
        collapsed: bool,
        files: usize,
    },
    File {
        depth: usize,
        path: String,
        label: String,
        badge: FileBadge,
        lines: Option<(u32, u32)>,
        notes: usize,
        viewed: bool,
        /// Viewed marks are for the branch's final diff; other files have none.
        markable: bool,
        selected: bool,
        since: Option<SinceKind>,
        unsaved: bool,
    },
}

fn rows(ws: &Workspace, cx: &App) -> Vec<Row> {
    let model = ws.model.read(cx);
    let Some(review) = model.review.as_ref() else {
        return Vec::new();
    };
    model
        .tree()
        .into_iter()
        .map(|row| match row.entry {
            TreeEntry::Folder {
                path,
                name,
                collapsed,
                files,
            } => Row::Folder {
                depth: row.depth,
                path,
                name,
                collapsed,
                files,
            },
            TreeEntry::File { index, name } => {
                let file = &model.visible[index];
                let label = match (&file.change.old_path, file.badge()) {
                    (Some(old), FileBadge::Renamed | FileBadge::Copied) => {
                        rename_label(old, file.path(), &name)
                    }
                    _ => name,
                };
                Row::File {
                    depth: row.depth,
                    path: file.path().to_owned(),
                    label,
                    badge: file.badge(),
                    lines: file.line_counts(),
                    notes: review.notes_on(file.path()).filter(|n| n.is_open()).count(),
                    viewed: model.is_viewed(file.path()),
                    markable: model.final_file(file.path()).is_some(),
                    selected: model.selected.as_deref() == Some(file.path()),
                    since: model.entry(file.path()).and_then(|e| e.since),
                    unsaved: model.unsaved.as_deref() == Some(file.path()),
                }
            }
        })
        .collect()
}

/// `dir/{old → new}` when only the name changed, else `old → shown`.
fn rename_label(old: &str, new: &str, shown: &str) -> String {
    let split = |path: &str| -> (String, String) {
        match path.rsplit_once('/') {
            Some((dir, name)) => (dir.to_owned(), name.to_owned()),
            None => (String::new(), path.to_owned()),
        }
    };
    let ((old_dir, old_name), (new_dir, new_name)) = (split(old), split(new));
    if old_dir == new_dir {
        let prefix = shown.strip_suffix(new_name.as_str()).unwrap_or_default();
        format!("{prefix}{{{old_name} → {new_name}}}")
    } else {
        format!("{old} → {shown}")
    }
}

pub fn render(ws: &mut Workspace, _: &mut Window, cx: &mut Context<Workspace>) -> impl IntoElement {
    let theme = cx.theme().clone();
    let code = *cx.code();
    let order = ws.model.read(cx).order;
    let rows = Rc::new(rows(ws, cx));
    let count = rows.len();

    let order_toggle = |label: &'static str, this: FileOrder| {
        let on = order == this;
        div()
            .id(label)
            .px_1()
            .cursor_pointer()
            .when(on, |el| el.bg(code.bg_3).text_color(theme.foreground))
            .when(!on, |el| el.text_color(theme.muted_foreground))
            .child(label)
            .on_click(move |_, window, cx| {
                if !on {
                    window.dispatch_action(Box::new(ToggleOrder), cx);
                }
            })
    };
    let header = h_flex()
        .px(code.metrics.pad_x)
        .py_1()
        .gap_2()
        .child(div().flex_1().child(Input::new(&ws.filter_input).xsmall()))
        .child(key_hint("/", cx))
        .child(
            h_flex()
                .font_family(theme.mono_font_family.clone())
                .border_1()
                .border_color(theme.border)
                .rounded(theme.radius)
                .child(order_toggle("folders", FileOrder::Folders))
                .child(order_toggle("risk", FileOrder::Risk)),
        );

    let list = uniform_list(
        "files",
        count,
        cx.processor(move |_, range: std::ops::Range<usize>, _, cx| {
            range
                .map(|i| render_row(i, &rows[i], cx).into_any_element())
                .collect::<Vec<_>>()
        }),
    )
    .flex_1()
    .size_full();

    v_flex().size_full().child(header).child(
        div()
            .flex_1()
            .min_h_0()
            .font_family(theme.mono_font_family.clone())
            .child(list)
            .when(count == 0, |this| {
                this.child(
                    div()
                        .px(code.metrics.pad_x)
                        .text_color(theme.muted_foreground)
                        .child("no files match"),
                )
            }),
    )
}

fn render_row(i: usize, row: &Row, cx: &mut Context<Workspace>) -> impl IntoElement {
    let theme = cx.theme().clone();
    let code = *cx.code();
    let indent = |depth: usize| px(8. + depth as f32 * 12.);
    let base = div()
        .id(("file-row", i))
        .w_full()
        .h(code.metrics.row)
        .flex()
        .items_center()
        .gap_1p5()
        .pr(code.metrics.pad_x)
        .whitespace_nowrap()
        .overflow_hidden()
        .cursor_pointer();
    match row.clone() {
        Row::Folder {
            depth,
            path,
            name,
            collapsed,
            files,
        } => base
            .pl(indent(depth))
            .text_color(theme.muted_foreground)
            .hover(|this| this.bg(code.bg_2))
            .child(if collapsed { "▸" } else { "▾" })
            .child(format!("{name}/"))
            .when(collapsed, |this| this.child(format!("({files})")))
            .on_click(cx.listener(move |ws, _, _, cx| {
                let path = path.clone();
                ws.model.update(cx, |m, cx| m.toggle_folder(path, cx));
            }))
            .into_any_element(),
        Row::File {
            depth,
            path,
            label,
            badge,
            lines,
            notes,
            viewed,
            markable,
            selected,
            since,
            unsaved,
        } => {
            let toggle_path = path.clone();
            base.pl(indent(depth))
                .when(selected, |this| this.bg(code.row_current))
                .when(!selected, |this| this.hover(|this| this.bg(code.bg_2)))
                .child(
                    div()
                        .id(("viewed", i))
                        .text_color(if viewed {
                            code.add
                        } else {
                            theme.muted_foreground
                        })
                        .child(match (markable, viewed) {
                            (false, _) => "   ",
                            (true, true) => "[x]",
                            (true, false) => "[ ]",
                        })
                        .on_click(cx.listener(move |ws, _, _, cx| {
                            cx.stop_propagation();
                            let path = toggle_path.clone();
                            ws.model
                                .update(cx, |m, cx| m.toggle_viewed(path, false, cx));
                        })),
                )
                .child(
                    div()
                        .w(px(10.))
                        .font_weight(FontWeight::BOLD)
                        .text_color(badge_color(badge, cx))
                        .child(badge.letter()),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .when(viewed && !selected, |this| {
                            this.text_color(theme.muted_foreground)
                        })
                        .child(label),
                )
                .when(unsaved, |this| {
                    this.child(div().text_color(code.modified).child("●"))
                })
                .when(notes > 0, |this| {
                    this.child(div().text_color(code.suggestion).child(format!("✎{notes}")))
                })
                .children(since.map(|kind| since_tag(kind, cx)))
                .when(since.is_none(), |this| {
                    this.children(lines.map(|(a, d)| counts(a, d, cx)))
                })
                .on_click(cx.listener(move |ws, _, _, cx| {
                    let path = path.clone();
                    ws.model.update(cx, |m, cx| m.select(path, cx));
                }))
                .into_any_element()
        }
    }
}

fn since_tag(kind: SinceKind, cx: &App) -> Div {
    let code = cx.code();
    let (label, color) = match kind {
        SinceKind::New => ("new", code.add),
        SinceKind::Changed => ("changed", code.modified),
        SinceKind::Missing => ("full", code.del),
        SinceKind::Unchanged => ("same", cx.theme().muted_foreground),
    };
    div()
        .px_1()
        .rounded(cx.theme().radius)
        .bg(color.opacity(0.14))
        .text_color(color)
        .child(label)
}
