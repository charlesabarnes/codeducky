//! The selected file in gpui-kit's code editor: syntax highlighting, line numbers, search,
//! undo and redo come with it. Saving goes through the repo's host.

use ducky_git::Repo;
use ducky_session::ViewEntry;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Editor, EditorState, InputEvent, Position};
use gpui_kit::component::{ActiveTheme, Disableable as _, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::keymap::{FILE_EDITOR, LEAVE_EDITOR_KEYS, RevertFile, SAVE_FILE_KEYS, SaveFile};
use crate::state::editor::{EditorEvent, EditorModel};
use crate::theme::ActiveCode;
use crate::views::widgets::{key_hint, muted};
use crate::views::workspace::Workspace;

pub struct EditorPane {
    pub model: Entity<EditorModel>,
    pub state: Entity<EditorState>,
    workspace: WeakEntity<Workspace>,
    /// Where to put the cursor once the text is in.
    goto: Option<u32>,
    _subscriptions: Vec<Subscription>,
}

impl EditorPane {
    pub fn new(
        repo: Repo,
        entry: ViewEntry,
        goto: Option<u32>,
        workspace: WeakEntity<Workspace>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let language = language_for(entry.file.path());
        let state = cx.new(|cx| {
            EditorState::new(window, cx)
                .language(language)
                .line_number(true)
                .searchable(true)
        });
        let model = cx.new(|cx| EditorModel::new(repo, entry, cx));
        let subscriptions = vec![
            cx.subscribe_in(&model, window, Self::on_editor_event),
            cx.subscribe_in(&state, window, |this, state, event: &InputEvent, _, cx| {
                if matches!(event, InputEvent::Change) {
                    let text = state.read(cx).value().to_string();
                    this.model.update(cx, |m, cx| m.set_text(&text, cx));
                    this.sync_unsaved(cx);
                }
            }),
            cx.observe(&model, |_, _, cx| cx.notify()),
        ];
        Self {
            model,
            state,
            workspace,
            goto,
            _subscriptions: subscriptions,
        }
    }

    pub fn path(&self, cx: &App) -> String {
        self.model.read(cx).path.clone()
    }

    pub fn is_dirty(&self, cx: &App) -> bool {
        self.model.read(cx).dirty
    }

    /// The (1-based) line the cursor is on.
    pub fn cursor_line(&self, cx: &App) -> u32 {
        self.state.read(cx).cursor_position().line + 1
    }

    pub fn goto_line(&mut self, line: u32, window: &mut Window, cx: &mut Context<Self>) {
        if self.model.read(cx).buffer.is_none() {
            self.goto = Some(line);
            return;
        }
        let position = Position {
            line: line.saturating_sub(1),
            character: 0,
        };
        self.state.update(cx, |state, cx| {
            state.unfold_at(position, cx);
            state.set_cursor_position(position, window, cx);
        });
    }

    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        self.state.update(cx, |state, cx| state.focus(window, cx));
    }

    /// Replaces the text, as typing would; for dev scripting.
    pub fn set_text(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| {
            let at = state.cursor_position();
            state.set_value(text.clone(), window, cx);
            state.set_cursor_position(at, window, cx);
        });
        self.model.update(cx, |m, cx| m.set_text(&text, cx));
        self.sync_unsaved(cx);
    }

    pub fn save(&mut self, force: bool, cx: &mut Context<Self>) {
        let text = self.state.read(cx).value().to_string();
        self.model.update(cx, |m, cx| m.save(text, force, cx));
    }

    pub fn revert(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(text) = self.model.read(cx).buffer.as_ref().map(|b| b.text.clone()) else {
            return;
        };
        self.set_text(text, window, cx);
    }

    fn sync_unsaved(&self, cx: &mut Context<Self>) {
        let (dirty, path) = (self.is_dirty(cx), self.path(cx));
        if let Some(ws) = self.workspace.upgrade() {
            ws.update(cx, |ws, cx| {
                ws.model.update(cx, |m, cx| {
                    let next = dirty.then_some(path);
                    if m.unsaved != next {
                        m.unsaved = next;
                        cx.notify();
                    }
                })
            });
        }
    }

    fn on_editor_event(
        &mut self,
        _: &Entity<EditorModel>,
        event: &EditorEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            EditorEvent::Loaded => {
                let text = self
                    .model
                    .read(cx)
                    .buffer
                    .as_ref()
                    .map(|b| b.text.clone())
                    .unwrap_or_default();
                self.state
                    .update(cx, |state, cx| state.set_value(text, window, cx));
                if let Some(line) = self.goto.take() {
                    self.goto_line(line, window, cx);
                }
                self.sync_unsaved(cx);
            }
            EditorEvent::Saved => {
                self.sync_unsaved(cx);
                let path = self.path(cx);
                if let Some(ws) = self.workspace.upgrade() {
                    ws.update(cx, |ws, cx| {
                        ws.model.update(cx, |m, cx| {
                            m.say(format!("saved {path}"), cx);
                            m.refresh(cx);
                        })
                    });
                }
            }
        }
    }
}

/// gpui-kit's tree-sitter names for a path, by its file name.
pub fn language_for(path: &str) -> &'static str {
    let name = path.rsplit('/').next().unwrap_or(path).to_lowercase();
    if matches!(name.as_str(), "makefile" | "gnumakefile") {
        return "make";
    }
    match name
        .rsplit_once('.')
        .map(|(_, ext)| ext)
        .unwrap_or_default()
    {
        "rs" => "rust",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "py" | "pyi" => "python",
        "go" => "go",
        "rb" => "ruby",
        "java" => "java",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" | "hxx" => "cpp",
        "cs" => "csharp",
        "swift" => "swift",
        "kt" | "kts" => "kotlin",
        "json" | "jsonc" => "json",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "md" | "mdx" => "markdown",
        "html" | "htm" => "html",
        "css" | "scss" => "css",
        "sh" | "bash" | "zsh" => "bash",
        "sql" => "sql",
        "lua" => "lua",
        "zig" => "zig",
        "ex" | "exs" => "elixir",
        "graphql" | "gql" => "graphql",
        "proto" => "proto",
        _ => "text",
    }
}

impl Render for EditorPane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let code = *cx.code();
        let model = self.model.read(cx);
        let path = model.path.clone();
        let language = language_for(&path);
        let dirty = model.dirty;
        let busy = model.busy;
        let conflict = model.conflict;
        let problem = model.problem.clone();
        let loaded = model.buffer.is_some();

        let toolbar = h_flex()
            .h(code.metrics.bar)
            .flex_none()
            .px(code.metrics.pad_x)
            .gap_3()
            .border_b_1()
            .border_color(theme.border)
            .font_family(theme.mono_font_family.clone())
            .child(div().font_weight(FontWeight::BOLD).child(path.clone()))
            .when(dirty, |this| {
                this.child(div().text_color(code.modified).child("● unsaved"))
            })
            .child(muted(
                if language == "text" {
                    "plain text"
                } else {
                    language
                },
                cx,
            ))
            .child(div().flex_1())
            .children(busy.map(|b| muted(format!("{b}…"), cx)))
            .child(
                h_flex()
                    .gap_1()
                    .child(key_hint(LEAVE_EDITOR_KEYS, cx))
                    .child(muted("diff", cx)),
            )
            .child(
                Button::new("editor-revert")
                    .label("revert")
                    .xsmall()
                    .disabled(!dirty)
                    .on_click(cx.listener(|this, _, window, cx| this.revert(window, cx))),
            )
            .child(
                Button::new("editor-save")
                    .label(if busy == Some("saving") {
                        "saving…".to_owned()
                    } else {
                        format!("save {SAVE_FILE_KEYS}")
                    })
                    .xsmall()
                    .primary()
                    .disabled(!loaded || busy.is_some())
                    .on_click(cx.listener(|this, _, _, cx| this.save(false, cx))),
            );

        let prompt = conflict.map(|conflict| {
            let what = if conflict.deleted {
                format!("{path} was deleted on disk since you opened it.")
            } else {
                format!("{path} changed on disk since you opened it.")
            };
            v_flex()
                .px(code.metrics.pad_x)
                .py_1()
                .gap_1()
                .bg(code.del.opacity(0.12))
                .border_b_1()
                .border_color(code.del.opacity(0.5))
                .child(format!(
                    "{what} Reload it (your edits are replaced) or overwrite it with yours."
                ))
                .child(
                    h_flex()
                        .gap_2()
                        .child(
                            Button::new("conflict-reload")
                                .label("reload")
                                .xsmall()
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.model.update(cx, |m, cx| m.load(cx))
                                })),
                        )
                        .child(
                            Button::new("conflict-overwrite")
                                .label("overwrite")
                                .xsmall()
                                .danger()
                                .on_click(cx.listener(|this, _, _, cx| this.save(true, cx))),
                        )
                        .child(
                            Button::new("conflict-keep")
                                .label("keep editing")
                                .xsmall()
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.model.update(cx, |m, cx| m.keep_editing(cx))
                                })),
                        ),
                )
        });
        let problem_row = problem.map(|text| {
            div()
                .px(code.metrics.pad_x)
                .py_1()
                .bg(code.gap_bg)
                .border_b_1()
                .border_color(theme.border)
                .child(text)
        });

        v_flex()
            .id("editor-pane")
            .key_context(FILE_EDITOR)
            .size_full()
            .on_action(cx.listener(|this, _: &SaveFile, _, cx| this.save(false, cx)))
            .on_action(cx.listener(|this, _: &RevertFile, window, cx| this.revert(window, cx)))
            .child(toolbar)
            .children(prompt)
            .children(problem_row)
            .child(div().flex_1().min_h_0().when(loaded, |this| {
                this.child(
                    Editor::new(&self.state)
                        .bordered(false)
                        .bg(theme.background)
                        .h_full()
                        .size_full(),
                )
            }))
    }
}
