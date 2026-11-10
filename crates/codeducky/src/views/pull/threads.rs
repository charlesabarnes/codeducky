//! Review threads from GitHub: a card under the line they are on (or above the diff when
//! outdated or on the whole file), with replies and resolving; and the threads tab.

use ducky_github::threads::ReviewThread;
use ducky_review::{Side, Timestamp};
use gpui_kit::component::input::{Textarea, TextareaState};
use gpui_kit::component::text::TextView;
use gpui_kit::component::{ActiveTheme, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::keymap::{CancelNote, NOTE_EDITOR, SaveNote};
use crate::state::PullModel;
use crate::theme::ActiveCode;
use crate::views::pull::time::ago;
use crate::views::widgets::muted;
use crate::views::workspace::Workspace;

pub fn where_label(thread: &ReviewThread) -> String {
    if thread.file_level {
        return "on the file".into();
    }
    let line = thread.line.or(thread.original_line);
    let line = line.map_or("?".to_owned(), |l| l.to_string());
    let base = if thread.side == Side::Old {
        " (base)"
    } else {
        ""
    };
    if thread.is_outdated {
        format!("outdated, was line {line}{base}")
    } else {
        format!("line {line}{base}")
    }
}

fn link(
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

pub struct ThreadView<'a> {
    pub thread: &'a ReviewThread,
    pub focused: bool,
    pub show_where: bool,
    pub reply: Option<Entity<TextareaState>>,
    pub writes_off: Option<&'static str>,
}

pub fn thread_card(
    view: ThreadView,
    pull: WeakEntity<PullModel>,
    workspace: WeakEntity<Workspace>,
    cx: &App,
) -> AnyElement {
    let theme = cx.theme();
    let code = cx.code();
    let thread = view.thread;
    let now = Timestamp::now();
    let first = thread.comments.first();
    let key = |suffix: &str| SharedString::from(format!("{}-{suffix}", thread.id));
    let resolved = thread.is_resolved;
    let open = !resolved || view.focused || view.reply.is_some();
    let can_toggle = if resolved {
        thread.can_unresolve
    } else {
        thread.can_resolve
    };
    let id = thread.id.clone();
    let reply_action = {
        let (workspace, id) = (workspace.clone(), id.clone());
        move |window: &mut Window, cx: &mut App| {
            workspace
                .update(cx, |ws, cx| ws.start_reply(id.clone(), window, cx))
                .ok();
        }
    };
    let resolve_action = {
        let (pull, id) = (pull.clone(), id.clone());
        move |_: &mut Window, cx: &mut App| {
            pull.update(cx, |p, cx| p.toggle_resolved(id.clone(), cx))
                .ok();
        }
    };
    let pending = thread.comments.iter().any(|c| c.pending);
    let tag = |text: String, color: Hsla| {
        div()
            .px_1()
            .rounded(theme.radius)
            .border_1()
            .border_color(color.opacity(0.6))
            .text_color(color)
            .child(text)
    };
    let header = h_flex()
        .px_2()
        .py_0p5()
        .gap_2()
        .border_b_1()
        .border_color(theme.border)
        .bg(code.bg_2)
        .font_family(theme.mono_font_family.clone())
        .child(div().text_color(code.accent).child("◆"))
        .child(
            div()
                .font_weight(FontWeight::BOLD)
                .child(first.map_or("unknown".to_owned(), |c| c.author.clone())),
        )
        .child(muted(
            format!(
                "{} comment{}",
                thread.comments.len(),
                if thread.comments.len() == 1 { "" } else { "s" }
            ),
            cx,
        ))
        .when(view.show_where, |this| {
            this.child(muted(
                format!("{} · {}", thread.path, where_label(thread)),
                cx,
            ))
        })
        .when(thread.is_outdated, |this| {
            this.child(tag("outdated".into(), theme.muted_foreground))
        })
        .when(resolved, |this| {
            this.child(tag(
                match &thread.resolved_by {
                    Some(by) => format!("resolved by {by}"),
                    None => "resolved".into(),
                },
                code.add,
            ))
        })
        .when(pending, |this| {
            this.child(tag("pending".into(), code.modified))
        })
        .child(div().flex_1())
        .when(view.writes_off.is_none() && thread.can_reply, |this| {
            this.child(link(key("reply"), "reply", "R", cx, reply_action))
        })
        .when(view.writes_off.is_none() && can_toggle, |this| {
            this.child(link(
                key("resolve"),
                if resolved { "unresolve" } else { "resolve" },
                "X",
                cx,
                resolve_action,
            ))
        })
        .when_some(view.writes_off, |this, reason| {
            this.child(muted(reason, cx))
        });

    let comments = thread.comments.iter().enumerate().map(|(i, comment)| {
        v_flex()
            .px_2()
            .py_1()
            .gap_0p5()
            .when(i > 0, |this| this.border_t_1().border_color(theme.border))
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(comment.author.clone()),
                    )
                    .child(muted(ago(&comment.created_at, now), cx))
                    .when(comment.pending, |this| {
                        this.child(tag("pending".into(), code.modified))
                    }),
            )
            .child(
                TextView::markdown(
                    SharedString::from(format!("{}-c{i}", thread.id)),
                    comment.body.clone(),
                )
                .selectable(true),
            )
    });
    let snippet = first.map(|c| {
        c.body
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or_default()
            .to_owned()
    });
    let reply_box = view
        .reply
        .map(|input| reply_editor(&thread.id, input, pull, workspace, cx));

    v_flex()
        .id(key("card"))
        .my_1()
        .mx_2()
        .max_w(px(760.))
        .border_1()
        .border_color(if view.focused {
            code.accent
        } else {
            code.accent.opacity(0.45)
        })
        .rounded(theme.radius)
        .bg(theme.background)
        .when(resolved && !open, |this| this.opacity(0.75))
        .child(header)
        .when(open, |this| this.children(comments))
        .when(!open, |this| {
            this.child(
                div()
                    .px_2()
                    .py_0p5()
                    .text_color(theme.muted_foreground)
                    .children(snippet),
            )
        })
        .children(reply_box)
        .into_any_element()
}

fn reply_editor(
    thread: &str,
    input: Entity<TextareaState>,
    pull: WeakEntity<PullModel>,
    workspace: WeakEntity<Workspace>,
    cx: &App,
) -> AnyElement {
    let theme = cx.theme();
    let busy = pull
        .upgrade()
        .and_then(|p| p.read(cx).busy.clone())
        .is_some();
    let send = {
        let workspace = workspace.clone();
        move |window: &mut Window, cx: &mut App| {
            workspace
                .update(cx, |ws, cx| ws.send_reply(window, cx))
                .ok();
        }
    };
    let cancel = {
        let workspace = workspace.clone();
        move |window: &mut Window, cx: &mut App| {
            workspace
                .update(cx, |ws, cx| ws.cancel_reply(window, cx))
                .ok();
        }
    };
    let on_save = {
        let send = send.clone();
        move |_: &SaveNote, window: &mut Window, cx: &mut App| send(window, cx)
    };
    let on_cancel = {
        let cancel = cancel.clone();
        move |_: &CancelNote, window: &mut Window, cx: &mut App| cancel(window, cx)
    };
    v_flex()
        .id(SharedString::from(format!("{thread}-reply")))
        .key_context(NOTE_EDITOR)
        .on_action(on_save)
        .on_action(on_cancel)
        .border_t_1()
        .border_color(theme.border)
        .child(div().p_1().child(Textarea::new(&input)))
        .child(
            h_flex()
                .px_2()
                .pb_1()
                .gap_2()
                .font_family(theme.mono_font_family.clone())
                .child(muted("posts to GitHub right away · Markdown", cx).flex_1())
                .child(link(
                    SharedString::from(format!("{thread}-reply-cancel")),
                    "cancel",
                    "esc",
                    cx,
                    cancel,
                ))
                .child(link(
                    SharedString::from(format!("{thread}-reply-send")),
                    if busy { "sending…" } else { "reply" },
                    crate::keymap::SAVE_KEYS,
                    cx,
                    send,
                )),
        )
        .into_any_element()
}

/// The threads tab: every thread, by file, unresolved first within each file.
pub fn render_tab(ws: &mut Workspace, cx: &mut Context<Workspace>) -> AnyElement {
    let theme = cx.theme().clone();
    let pull = ws.pull.read(cx);
    let threads = pull.threads().to_vec();
    let error = pull.activity_error.clone();
    let loading = pull.activity.is_none() && error.is_none();
    let focus = pull.thread_focus.clone();
    let mut by_file: Vec<(String, Vec<ReviewThread>)> = Vec::new();
    for thread in threads {
        match by_file.iter_mut().find(|(p, _)| *p == thread.path) {
            Some((_, list)) => list.push(thread),
            None => by_file.push((thread.path.clone(), vec![thread])),
        }
    }
    let rows = by_file.into_iter().map(|(path, mut list)| {
        list.sort_by_key(|t| (t.is_resolved, t.line.unwrap_or(0)));
        v_flex()
            .child(
                div()
                    .px_2()
                    .pt_2()
                    .font_family(theme.mono_font_family.clone())
                    .font_weight(FontWeight::BOLD)
                    .child(path),
            )
            .children(list.into_iter().map(|thread| {
                let id = thread.id.clone();
                let focused = focus.as_deref() == Some(thread.id.as_str());
                let first = thread
                    .comments
                    .first()
                    .map(|c| {
                        (
                            c.author.clone(),
                            c.body.lines().next().unwrap_or("").to_owned(),
                        )
                    })
                    .unwrap_or_default();
                v_flex()
                    .id(SharedString::from(format!("tab-{id}")))
                    .px_2()
                    .py_1()
                    .mx_1()
                    .rounded(theme.radius)
                    .cursor_pointer()
                    .when(focused, |this| this.bg(cx.code().bg_3))
                    .hover(|this| this.bg(cx.code().bg_2))
                    .when(thread.is_resolved, |this| this.opacity(0.6))
                    .child(
                        h_flex()
                            .gap_2()
                            .child(div().font_weight(FontWeight::SEMIBOLD).child(first.0))
                            .child(muted(where_label(&thread), cx))
                            .when(thread.is_resolved, |this| this.child(muted("resolved", cx))),
                    )
                    .child(
                        div()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_color(theme.muted_foreground)
                            .child(first.1),
                    )
                    .on_click(cx.listener(move |ws, _, window, cx| {
                        ws.focus_thread(id.clone(), window, cx);
                    }))
            }))
    });
    v_flex()
        .id("threads-tab")
        .size_full()
        .overflow_y_scroll()
        .when(loading, |this| {
            this.child(muted("loading threads…", cx).p_2())
        })
        .children(error.map(|e| div().p_2().text_color(cx.code().del).child(e)))
        .children(rows)
        .into_any_element()
}
