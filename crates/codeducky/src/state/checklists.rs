//! The review's checklists: loading them, ticking items, and the manager's edits.

use ducky_review::checklist::{Checklist, ChecklistDraft, ChecklistScope};
use ducky_review::{ChecklistId, ChecklistItemId};
use ducky_session::{ChecklistStore, Checklists};
use gpui_kit::*;

use super::model::{ReviewModel, Work};
use crate::config;

/// One manager edit, applied in the background and followed by a reload.
#[derive(Debug, Clone)]
pub enum ChecklistEdit {
    Create(ChecklistScope, ChecklistDraft),
    Save(ChecklistScope, Checklist),
    Delete(ChecklistScope, ChecklistId),
    Import {
        scope: ChecklistScope,
        file_name: String,
        text: String,
    },
}

impl ReviewModel {
    /// Global checklists live in the app's config folder. A scripted dev run without
    /// `CODEDUCKY_CONFIG_DIR` keeps them off, so it never writes the real folder.
    fn global_checklists_dir(&self) -> Option<String> {
        if !self.persist && std::env::var_os("CODEDUCKY_CONFIG_DIR").is_none() {
            return None;
        }
        config::config_dir().map(|dir| dir.to_string_lossy().into_owned())
    }

    pub fn checklist_store(&self) -> Option<ChecklistStore> {
        let review = self.review.as_ref()?;
        Some(review.checklist_store(self.global_checklists_dir()))
    }

    pub fn load_checklists(&mut self, cx: &mut Context<Self>) {
        let Some(store) = self.checklist_store() else {
            return;
        };
        self.run(
            "loading checklists",
            cx,
            Box::new(move || store.load().map_err(|e| e.to_string())),
            |this, lists, cx| {
                this.checklists = lists;
                cx.notify();
            },
        );
    }

    pub fn toggle_check(&mut self, item: ChecklistItemId, cx: &mut Context<Self>) {
        let Some(review) = self.review.as_ref() else {
            return;
        };
        let checked = !review.state.is_checked(&item);
        let service = review.notes_service().clone();
        self.run(
            "saving",
            cx,
            Box::new(move || {
                service
                    .set_checked(&item, checked)
                    .map_err(|e| e.to_string())
            }),
            |this, state, cx| {
                if let Some(review) = this.review.as_mut() {
                    review.state = state;
                }
                cx.notify();
            },
        );
    }

    pub fn edit_checklists(&mut self, edit: ChecklistEdit, cx: &mut Context<Self>) {
        let Some(store) = self.checklist_store() else {
            return;
        };
        let work: Work<(Checklists, Option<String>)> = Box::new(move || {
            let said = match edit {
                ChecklistEdit::Create(scope, draft) => store.create(scope, draft).map(|_| None),
                ChecklistEdit::Save(scope, list) => store.save(scope, list).map(|_| None),
                ChecklistEdit::Delete(scope, id) => store.delete(scope, &id).map(|_| None),
                ChecklistEdit::Import {
                    scope,
                    file_name,
                    text,
                } => store.import(scope, &file_name, &text).map(|count| {
                    Some(format!(
                        "imported {count} checklist{} into {}",
                        if count == 1 { "" } else { "s" },
                        scope_name(scope)
                    ))
                }),
            }
            .map_err(|e| e.to_string())?;
            Ok((store.load().map_err(|e| e.to_string())?, said))
        });
        self.run("saving checklists", cx, work, |this, (lists, said), cx| {
            this.checklists = lists;
            if let Some(said) = said {
                this.say(said, cx);
            }
            cx.notify();
        });
    }

    #[cfg(feature = "screenshot")]
    pub fn export_all_checklists(&self, format: ducky_session::ExportFormat) -> String {
        let lists: Vec<&Checklist> = self
            .checklists
            .applicable()
            .into_iter()
            .map(|(_, list)| list)
            .collect();
        ducky_session::export_checklists(&lists, format)
    }

    pub fn has_global_checklists(&self) -> bool {
        self.global_checklists_dir().is_some()
    }
}

pub fn scope_name(scope: ChecklistScope) -> &'static str {
    match scope {
        ChecklistScope::Global => "global",
        ChecklistScope::Repo => "this repo",
    }
}
