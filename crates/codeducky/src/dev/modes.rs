//! Dev scripting for since-last-look, commits, checklists and the file editor.

use std::path::PathBuf;
use std::time::Duration;

use ducky_review::checklist::{ChecklistDraft, ChecklistScope};
use ducky_session::{ExportFormat, ReviewMode};
use gpui_kit::*;

use super::script::{fail, settle_until};
use crate::state::ReviewModel;
use crate::state::checklists::ChecklistEdit;
use crate::views::workspace::{Dialog, Workspace};

#[derive(Debug, Default)]
pub struct ModeSteps {
    mark_viewed: Vec<String>,
    mark_reviewed: bool,
    review_mode: Option<ReviewMode>,
    /// 1-based, inclusive.
    commits: Option<(usize, usize)>,
    commit_picker: bool,
    show_unchanged: bool,
    new_checklists: Vec<(ChecklistScope, String)>,
    imports: Vec<(ChecklistScope, PathBuf)>,
    checks: Vec<usize>,
    export: Option<PathBuf>,
    manager: bool,
    manager_form: Option<String>,
    edit: bool,
    edit_text: Option<String>,
    disk_write: Option<(String, String)>,
    save_file: bool,
    leave_editor: bool,
}

fn unescape(text: &str) -> String {
    text.replace("\\n", "\n")
}

impl ModeSteps {
    pub fn parse(&mut self, flag: &str, value: &mut dyn FnMut() -> String) -> bool {
        match flag {
            "--mark-viewed" => self.mark_viewed.push(value()),
            "--mark-reviewed" => self.mark_reviewed = true,
            "--review-mode" => {
                self.review_mode = Some(match value().as_str() {
                    "all" => ReviewMode::All,
                    "since" => ReviewMode::Since,
                    other => fail(format!("--review-mode: all or since, not {other}")),
                })
            }
            "--commit" => {
                let v = value();
                let number = |s: &str| {
                    s.parse::<usize>()
                        .ok()
                        .filter(|n| *n > 0)
                        .unwrap_or_else(|| fail(format!("--commit wants <n>[-<m>], 1-based: {v}")))
                };
                self.commits = Some(match v.split_once('-') {
                    Some((a, b)) => (number(a), number(b)),
                    None => (number(&v), number(&v)),
                });
            }
            "--commit-picker" => self.commit_picker = true,
            "--show-unchanged" => self.show_unchanged = true,
            "--new-checklist" | "--new-global-checklist" => {
                let scope = if flag == "--new-checklist" {
                    ChecklistScope::Repo
                } else {
                    ChecklistScope::Global
                };
                self.new_checklists.push((scope, value()));
            }
            "--import-checklists" => self
                .imports
                .push((ChecklistScope::Repo, PathBuf::from(value()))),
            "--import-global-checklists" => self
                .imports
                .push((ChecklistScope::Global, PathBuf::from(value()))),
            "--check" => {
                let v = value();
                self.checks.push(
                    v.parse()
                        .unwrap_or_else(|_| fail(format!("--check wants an item number: {v}"))),
                );
            }
            "--export-checklists" => self.export = Some(PathBuf::from(value())),
            "--checklists-manager" => self.manager = true,
            "--checklist-form" => self.manager_form = Some(value()),
            "--edit" => self.edit = true,
            "--edit-text" => self.edit_text = Some(unescape(&value())),
            "--disk-write" => {
                let v = value();
                let (path, text) = v
                    .split_once('=')
                    .unwrap_or_else(|| fail(format!("--disk-write wants <path>=<text>: {v}")));
                self.disk_write = Some((path.to_owned(), unescape(text)));
            }
            "--save-file" => self.save_file = true,
            "--leave-editor" => self.leave_editor = true,
            _ => return false,
        }
        true
    }

    /// Steps that change the review's state files run first, then the review is read again.
    pub async fn before_view(&self, model: &Entity<ReviewModel>, cx: &mut AsyncApp) {
        for path in &self.mark_viewed {
            cx.update(|cx| {
                model.update(cx, |m, cx| {
                    if m.is_viewed(path) {
                        return;
                    }
                    m.toggle_viewed(path.clone(), false, cx)
                })
            });
            settle_until(cx, model, "marking viewed", ReviewModel::is_ready).await;
        }
        if self.mark_reviewed {
            cx.update(|cx| model.update(cx, |m, cx| m.mark_reviewed(cx)));
            settle(cx, model, "marking reviewed").await;
        } else if !self.mark_viewed.is_empty() {
            cx.update(|cx| model.update(cx, |m, cx| m.refresh(cx)));
            settle(cx, model, "refreshing").await;
        }
        for (scope, spec) in &self.new_checklists {
            let (title, items) = spec.split_once(':').unwrap_or((spec, ""));
            let draft = ChecklistDraft {
                title: title.trim_end_matches('!').to_owned(),
                items: items.split(';').map(str::to_owned).collect(),
                required: title.ends_with('!'),
            };
            let edit = ChecklistEdit::Create(*scope, draft);
            cx.update(|cx| model.update(cx, |m, cx| m.edit_checklists(edit, cx)));
            settle(cx, model, "adding a checklist").await;
        }
        for (scope, path) in &self.imports {
            let text = std::fs::read_to_string(path)
                .unwrap_or_else(|e| fail(format!("{}: {e}", path.display())));
            let file_name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into();
            let edit = ChecklistEdit::Import {
                scope: *scope,
                file_name,
                text,
            };
            cx.update(|cx| model.update(cx, |m, cx| m.edit_checklists(edit, cx)));
            settle(cx, model, "importing checklists").await;
        }
        for number in &self.checks {
            let item = cx.update(|cx| {
                let m = model.read(cx);
                m.checklists
                    .applicable()
                    .into_iter()
                    .flat_map(|(_, list)| list.items.iter().map(|i| i.id.clone()))
                    .nth(number.saturating_sub(1))
            });
            let item = item.unwrap_or_else(|| fail(format!("--check: no item {number}")));
            cx.update(|cx| model.update(cx, |m, cx| m.toggle_check(item, cx)));
            settle(cx, model, "ticking").await;
        }
        if let Some(path) = &self.export {
            let format = match path.extension().and_then(|e| e.to_str()) {
                Some("json") => ExportFormat::Json,
                _ => ExportFormat::Markdown,
            };
            let text = cx.update(|cx| model.read(cx).export_all_checklists(format));
            std::fs::write(path, text).unwrap_or_else(|e| fail(format!("{}: {e}", path.display())));
            eprintln!("checklists exported to {}", path.display());
        }
        let mode = match self.commits {
            Some((from, to)) => {
                let mode = cx.update(|cx| {
                    let commits = &model.read(cx).review.as_ref()?.commits;
                    let range = ducky_review::commit_range::CommitRange {
                        from: from - 1,
                        to: to - 1,
                    };
                    ReviewMode::commits(range, commits)
                });
                Some(mode.unwrap_or_else(|| fail("--commit: no such commit".into())))
            }
            None => self.review_mode.clone(),
        };
        if let Some(mode) = mode {
            cx.update(|cx| model.update(cx, |m, cx| m.set_review_mode(mode, cx)));
            settle(cx, model, "switching mode").await;
        }
        cx.update(|cx| {
            model.update(cx, |m, cx| {
                if self.show_unchanged {
                    m.toggle_unchanged(cx);
                }
                m.show_commit_picker = self.commit_picker;
                cx.notify();
            })
        });
    }

    pub async fn after_view(
        &self,
        window: AnyWindowHandle,
        workspace: &Entity<Workspace>,
        model: &Entity<ReviewModel>,
        cx: &mut AsyncApp,
    ) {
        if self.manager {
            window
                .update(cx, |_, window, cx| {
                    workspace.update(cx, |ws, cx| {
                        ws.open_checklist_manager(cx);
                        if let (Some(form), Some(Dialog::Checklists(manager))) =
                            (&self.manager_form, &ws.dialog)
                        {
                            let (title, items) = form.split_once(':').unwrap_or((form, ""));
                            let items = items.replace(';', "\n");
                            manager.update(cx, |manager, cx| {
                                manager.open_form(ChecklistScope::Repo, None, window, cx);
                                manager.fill_form(title, &items, window, cx);
                            });
                        }
                    })
                })
                .ok();
        }
        if !self.edit {
            return;
        }
        window
            .update(cx, |_, window, cx| {
                workspace.update(cx, |ws, cx| ws.open_editor(window, cx))
            })
            .ok();
        wait_editor(workspace, cx, "opening the editor", |e| e.buffer.is_some()).await;
        if let Some(text) = &self.edit_text {
            window
                .update(cx, |_, window, cx| {
                    let editor = workspace.read(cx).editor.clone();
                    if let Some(editor) = editor {
                        editor.update(cx, |e, cx| e.set_text(text.clone(), window, cx));
                    }
                })
                .ok();
        }
        if let Some((path, text)) = &self.disk_write {
            let root = cx.update(|cx| {
                model
                    .read(cx)
                    .review
                    .as_ref()
                    .map(|r| r.toplevel().to_owned())
            });
            let root = root.unwrap_or_else(|| fail("--disk-write needs --open".into()));
            std::fs::write(format!("{root}/{path}"), text)
                .unwrap_or_else(|e| fail(format!("--disk-write: {e}")));
        }
        if self.save_file {
            cx.update(|cx| {
                let editor = workspace.read(cx).editor.clone();
                if let Some(editor) = editor {
                    editor.update(cx, |e, cx| e.save(false, cx));
                }
            });
            wait_editor(workspace, cx, "saving", |e| e.busy.is_none()).await;
            settle(cx, model, "refreshing after the save").await;
        }
        if self.leave_editor {
            window
                .update(cx, |_, window, cx| {
                    workspace.update(cx, |ws, cx| ws.leave_editor(window, cx))
                })
                .ok();
        }
    }
}

async fn settle(cx: &mut AsyncApp, model: &Entity<ReviewModel>, what: &str) {
    cx.background_executor()
        .timer(Duration::from_millis(150))
        .await;
    settle_until(cx, model, what, ReviewModel::is_ready).await;
}

async fn wait_editor(
    workspace: &Entity<Workspace>,
    cx: &mut AsyncApp,
    what: &str,
    done: impl Fn(&crate::state::editor::EditorModel) -> bool,
) {
    for _ in 0..600 {
        cx.background_executor()
            .timer(Duration::from_millis(50))
            .await;
        let state = cx.update(|cx| {
            let editor = workspace.read(cx).editor.clone()?;
            let model = editor.read(cx).model.read(cx);
            Some((done(model), model.problem.clone()))
        });
        match state {
            Some((true, _)) => return,
            Some((false, Some(problem))) => fail(format!("{what}: {problem}")),
            _ => {}
        }
    }
    fail(format!("{what}: timed out"));
}
