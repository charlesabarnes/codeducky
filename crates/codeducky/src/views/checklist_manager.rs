//! Add, edit, delete, import and export checklists. Items are edited one per line.

use std::path::PathBuf;

use ducky_review::checklist::{Checklist, ChecklistDraft, ChecklistItem, ChecklistScope};
use ducky_session::{ExportFormat, export_checklists};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState, Textarea, TextareaState};
use gpui_kit::component::{ActiveTheme, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::keymap::SubmitDialog;
use crate::state::checklists::{ChecklistEdit, scope_name};
use crate::theme::ActiveCode;
use crate::views::dialog::{backdrop, chip, field, frame};
use crate::views::widgets::muted;
use crate::views::workspace::Workspace;

struct Form {
    scope: ChecklistScope,
    /// `None` for a new checklist.
    editing: Option<Checklist>,
    title: Entity<InputState>,
    items: Entity<TextareaState>,
    required: bool,
}

pub struct ChecklistManager {
    workspace: WeakEntity<Workspace>,
    scope: ChecklistScope,
    form: Option<Form>,
    confirm_delete: Option<ducky_review::ChecklistId>,
}

impl ChecklistManager {
    /// `global`: global checklists are kept on this machine (see `ReviewModel`).
    pub fn new(workspace: WeakEntity<Workspace>, global: bool) -> Self {
        Self {
            workspace,
            scope: if global {
                ChecklistScope::Global
            } else {
                ChecklistScope::Repo
            },
            form: None,
            confirm_delete: None,
        }
    }

    fn apply(&self, edit: ChecklistEdit, cx: &mut App) {
        if let Some(ws) = self.workspace.upgrade() {
            ws.update(cx, |ws, cx| {
                ws.model.update(cx, |m, cx| m.edit_checklists(edit, cx))
            });
        }
    }

    pub fn open_form(
        &mut self,
        scope: ChecklistScope,
        editing: Option<Checklist>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (title, items, required) = match &editing {
            Some(list) => (
                list.title.clone(),
                list.items
                    .iter()
                    .map(|i| i.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n"),
                list.required,
            ),
            None => ("New checklist".to_owned(), String::new(), false),
        };
        let title = cx.new(|cx| InputState::new(window, cx).default_value(title));
        let items = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(4, 12)
                .placeholder("One item per line")
                .default_value(items)
        });
        title.update(cx, |input, cx| input.focus(window, cx));
        self.form = Some(Form {
            scope,
            editing,
            title,
            items,
            required,
        });
        cx.notify();
    }

    /// Sets the form's text, for dev scripting.
    #[cfg(feature = "screenshot")]
    pub fn fill_form(
        &mut self,
        title: &str,
        items: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(form) = &self.form {
            form.title.update(cx, |input, cx| {
                input.set_value(title.to_owned(), window, cx)
            });
            form.items.update(cx, |input, cx| {
                input.set_value(items.to_owned(), window, cx)
            });
        }
    }

    fn save_form(&mut self, cx: &mut Context<Self>) {
        let Some(form) = self.form.take() else {
            return;
        };
        let title = match form.title.read(cx).value().trim() {
            "" => "Untitled".to_owned(),
            title => title.to_owned(),
        };
        let texts: Vec<String> = form
            .items
            .read(cx)
            .value()
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect();
        let edit = match form.editing {
            Some(mut list) => {
                list.title = title;
                list.required = form.required;
                list.items = merge_items(&list.items, texts);
                ChecklistEdit::Save(form.scope, list)
            }
            None => ChecklistEdit::Create(
                form.scope,
                ChecklistDraft {
                    title,
                    items: texts,
                    required: form.required,
                },
            ),
        };
        self.apply(edit, cx);
        cx.notify();
    }

    fn import(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let scope = self.scope;
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Import".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(mut paths))) = paths.await else {
                return;
            };
            let Some(path) = paths.pop() else {
                return;
            };
            this.update(cx, |this, cx| this.import_file(scope, &path, cx))
                .ok();
        })
        .detach();
    }

    pub fn import_file(&mut self, scope: ChecklistScope, path: &std::path::Path, cx: &mut App) {
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        match std::fs::read_to_string(path) {
            Ok(text) => self.apply(
                ChecklistEdit::Import {
                    scope,
                    file_name,
                    text,
                },
                cx,
            ),
            Err(error) => self.say(
                format!("could not read {}: {error}", path.display()),
                true,
                cx,
            ),
        }
    }

    fn say(&self, text: String, error: bool, cx: &mut App) {
        if let Some(ws) = self.workspace.upgrade() {
            ws.update(cx, |ws, cx| {
                ws.model.update(cx, |m, cx| {
                    if error {
                        m.fail(text, cx)
                    } else {
                        m.say(text, cx)
                    }
                })
            });
        }
    }

    fn export(&mut self, lists: Vec<Checklist>, format: ExportFormat, cx: &mut Context<Self>) {
        let extension = match format {
            ExportFormat::Json => "json",
            ExportFormat::Markdown => "md",
        };
        let name = match &lists[..] {
            [one] => format!("{}.{extension}", slug(&one.title)),
            _ => format!("checklists.{extension}"),
        };
        let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("."), PathBuf::from);
        let path = cx.prompt_for_new_path(&home, Some(&name));
        let refs: Vec<&Checklist> = lists.iter().collect();
        let text = export_checklists(&refs, format);
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(path))) = path.await else {
                return;
            };
            this.update(cx, |this, cx| this.write_export(&path, &text, cx))
                .ok();
        })
        .detach();
    }

    pub fn write_export(&self, path: &std::path::Path, text: &str, cx: &mut App) {
        match std::fs::write(path, text) {
            Ok(()) => self.say(format!("exported to {}", path.display()), false, cx),
            Err(error) => self.say(
                format!("could not write {}: {error}", path.display()),
                true,
                cx,
            ),
        }
    }
}

/// Keeps the ids (and so the ticks) of items whose text is unchanged.
fn merge_items(old: &[ChecklistItem], texts: Vec<String>) -> Vec<ChecklistItem> {
    let mut unused: Vec<&ChecklistItem> = old.iter().collect();
    let mut fresh = 0;
    texts
        .into_iter()
        .map(
            |text| match unused.iter().position(|item| item.text == text) {
                Some(at) => unused.remove(at).clone(),
                None => {
                    fresh += 1;
                    ChecklistItem {
                        id: ducky_review::ChecklistItemId::new(format!(
                            "{}-{fresh}",
                            ducky_review::Timestamp::now().millis()
                        )),
                        text,
                    }
                }
            },
        )
        .collect()
}

fn slug(title: &str) -> String {
    let slug: String = title
        .chars()
        .map(|c| {
            if c.is_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    slug.trim_matches('-').to_owned()
}

impl Render for ChecklistManager {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let code = *cx.code();
        let Some(ws) = self.workspace.upgrade() else {
            return div().into_any_element();
        };
        let model = ws.read(cx).model.read(cx);
        let global_on = model.has_global_checklists();
        let lists: Vec<(ChecklistScope, Checklist)> = model
            .checklists
            .applicable()
            .into_iter()
            .map(|(scope, list)| (scope, list.clone()))
            .collect();

        let scope_chips = h_flex()
            .gap_1()
            .child(muted("scope", cx))
            .when(global_on, |this| {
                this.child(
                    chip(
                        "scope-global",
                        "global",
                        self.scope == ChecklistScope::Global,
                        cx,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.scope = ChecklistScope::Global;
                        cx.notify();
                    })),
                )
            })
            .child(
                chip(
                    "scope-repo",
                    "this repo",
                    self.scope == ChecklistScope::Repo,
                    cx,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.scope = ChecklistScope::Repo;
                    cx.notify();
                })),
            );
        let all = lists.iter().map(|(_, l)| l.clone()).collect::<Vec<_>>();
        let all_md = all.clone();
        let toolbar = h_flex()
            .gap_2()
            .flex_wrap()
            .child(
                Button::new("new-checklist")
                    .label("new checklist")
                    .small()
                    .primary()
                    .on_click(cx.listener(|this, _, window, cx| {
                        let scope = this.scope;
                        this.open_form(scope, None, window, cx)
                    })),
            )
            .child(
                Button::new("import-checklists")
                    .label("import…")
                    .small()
                    .on_click(cx.listener(|this, _, window, cx| this.import(window, cx))),
            )
            .child(
                Button::new("export-json")
                    .label("export all (json)")
                    .small()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.export(all.clone(), ExportFormat::Json, cx)
                    })),
            )
            .child(
                Button::new("export-md")
                    .label("export all (markdown)")
                    .small()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.export(all_md.clone(), ExportFormat::Markdown, cx)
                    })),
            );

        let confirm = self.confirm_delete.clone();
        let cards = lists.into_iter().enumerate().map(|(i, (scope, list))| {
            let action = |id: (&'static str, usize), label: String| {
                div()
                    .id(id)
                    .cursor_pointer()
                    .text_color(code.accent)
                    .child(label)
            };
            let (edit_list, md_list, json_list, delete_id) =
                (list.clone(), list.clone(), list.clone(), list.id.clone());
            let confirming = confirm.as_ref() == Some(&list.id);
            v_flex()
                .p_2()
                .gap_0p5()
                .border_1()
                .border_color(theme.border)
                .rounded(theme.radius)
                .child(
                    h_flex()
                        .gap_2()
                        .child(
                            div()
                                .font_weight(FontWeight::BOLD)
                                .child(list.title.clone()),
                        )
                        .when(list.required, |this| {
                            this.child(div().text_color(code.del).child("required"))
                        })
                        .child(muted(
                            format!("{} · {} items", scope_name(scope), list.items.len()),
                            cx,
                        ))
                        .child(div().flex_1())
                        .child(action(("cl-edit", i), "edit".into()).on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.open_form(scope, Some(edit_list.clone()), window, cx)
                            },
                        )))
                        .child(action(("cl-md", i), ".md".into()).on_click(cx.listener(
                            move |this, _, _, cx| {
                                this.export(vec![md_list.clone()], ExportFormat::Markdown, cx)
                            },
                        )))
                        .child(action(("cl-json", i), ".json".into()).on_click(cx.listener(
                            move |this, _, _, cx| {
                                this.export(vec![json_list.clone()], ExportFormat::Json, cx)
                            },
                        )))
                        .child(
                            action(
                                ("cl-delete", i),
                                if confirming {
                                    "confirm delete"
                                } else {
                                    "delete"
                                }
                                .into(),
                            )
                            .when(confirming, |this| this.text_color(code.del))
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    if this.confirm_delete.as_ref() == Some(&delete_id) {
                                        this.confirm_delete = None;
                                        this.apply(
                                            ChecklistEdit::Delete(scope, delete_id.clone()),
                                            cx,
                                        );
                                    } else {
                                        this.confirm_delete = Some(delete_id.clone());
                                    }
                                    cx.notify();
                                },
                            )),
                        ),
                )
                .children(
                    list.items
                        .iter()
                        .take(4)
                        .map(|item| muted(format!("- {}", item.text), cx)),
                )
        });

        let form = self.form.as_ref().map(|form| {
            let required = form.required;
            v_flex()
                .p_2()
                .gap_2()
                .border_1()
                .border_color(code.accent)
                .rounded(theme.radius)
                .child(
                    div()
                        .font_weight(FontWeight::BOLD)
                        .child(match form.editing {
                            Some(_) => format!("edit ({})", scope_name(form.scope)),
                            None => format!("new checklist ({})", scope_name(form.scope)),
                        }),
                )
                .child(field("title", Input::new(&form.title).small(), cx))
                .child(
                    chip(
                        "required",
                        "required (flagged until every item is ticked)",
                        required,
                        cx,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Some(form) = this.form.as_mut() {
                            form.required = !form.required;
                        }
                        cx.notify();
                    })),
                )
                .child(field("items, one per line", Textarea::new(&form.items), cx))
                .child(
                    h_flex()
                        .gap_2()
                        .justify_end()
                        .child(Button::new("form-cancel").label("cancel").small().on_click(
                            cx.listener(|this, _, _, cx| {
                                this.form = None;
                                cx.notify();
                            }),
                        ))
                        .child(
                            Button::new("form-save")
                                .label("save")
                                .small()
                                .primary()
                                .on_click(cx.listener(|this, _, _, cx| this.save_form(cx))),
                        ),
                )
        });

        let card = frame("checklist-manager", "Checklists", 640., cx)
            .on_action(cx.listener(|this, _: &SubmitDialog, _, cx| this.save_form(cx)))
            .font_family(theme.mono_font_family.clone())
            .child(muted(
                if global_on {
                    "Global checklists apply to every repo (kept on this machine). Repo \
                     checklists apply to this repo only (kept beside its notes)."
                } else {
                    "Repo checklists apply to this repo only (kept beside its notes)."
                },
                cx,
            ))
            .child(scope_chips)
            .child(toolbar)
            .children(form)
            .children(cards);
        backdrop(v_flex().child(card), cx).into_any_element()
    }
}
