use std::sync::Arc;

use ducky_host::{Host, LocalHost};
use ducky_notes::NotesRepo;
use ducky_review::checklist::{
    Checklist, ChecklistScope, applicable_checklists, checklists_to_json, checklists_to_markdown,
    parse_checklist_file,
};
use ducky_review::{ChecklistId, ReviewState};

use crate::error::Result;

/// The global checklists (this machine's app folder) and the repository's (beside its notes).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Checklists {
    pub global: Vec<Checklist>,
    pub repo: Vec<Checklist>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ChecklistProgress {
    pub ticked: usize,
    pub total: usize,
    /// Unticked items on required checklists.
    pub required_open: usize,
}

impl Checklists {
    pub fn applicable(&self) -> Vec<(ChecklistScope, &Checklist)> {
        applicable_checklists(&self.global, &self.repo)
            .into_iter()
            .map(|scoped| (scoped.scope, scoped.checklist))
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.global.is_empty() && self.repo.is_empty()
    }

    pub fn progress(&self, state: &ReviewState) -> ChecklistProgress {
        let mut progress = ChecklistProgress::default();
        for (_, list) in self.applicable() {
            for item in &list.items {
                let ticked = state.is_checked(&item.id);
                progress.total += 1;
                progress.ticked += usize::from(ticked);
                progress.required_open += usize::from(list.required && !ticked);
            }
        }
        progress
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Json,
    Markdown,
}

pub fn export_checklists(lists: &[&Checklist], format: ExportFormat) -> String {
    let drafts: Vec<_> = lists.iter().map(|list| list.to_draft()).collect();
    match format {
        ExportFormat::Json => checklists_to_json(&drafts),
        ExportFormat::Markdown => checklists_to_markdown(&drafts),
    }
}

/// Where checklists are kept. Blocking, like the rest of the session.
#[derive(Clone)]
pub struct ChecklistStore {
    repo: NotesRepo,
    host: Arc<dyn Host>,
    global: Option<NotesRepo>,
}

impl ChecklistStore {
    /// `global_dir` is a folder on this machine; `None` keeps only repo checklists.
    pub fn new(repo: NotesRepo, host: Arc<dyn Host>, global_dir: Option<String>) -> Self {
        Self {
            repo,
            host,
            global: global_dir.map(|dir| NotesRepo::at(dir).without_readme()),
        }
    }

    fn place(&self, scope: ChecklistScope) -> (&NotesRepo, &dyn Host) {
        match (scope, &self.global) {
            (ChecklistScope::Global, Some(global)) => (global, &LocalHost),
            _ => (&self.repo, &*self.host),
        }
    }

    pub fn load(&self) -> Result<Checklists> {
        let global = match &self.global {
            Some(global) => global.checklists(&LocalHost)?,
            None => Vec::new(),
        };
        Ok(Checklists {
            global,
            repo: self.repo.checklists(&*self.host)?,
        })
    }

    pub fn save(&self, scope: ChecklistScope, checklist: Checklist) -> Result<()> {
        let (store, host) = self.place(scope);
        Ok(store.save_checklist(host, checklist)?)
    }

    /// A new checklist with fresh ids, from a title and items.
    pub fn create(
        &self,
        scope: ChecklistScope,
        draft: ducky_review::checklist::ChecklistDraft,
    ) -> Result<Checklist> {
        let (store, host) = self.place(scope);
        Ok(store
            .add_checklists(host, vec![draft])?
            .into_iter()
            .next()
            .expect("one draft adds one checklist"))
    }

    pub fn delete(&self, scope: ChecklistScope, id: &ChecklistId) -> Result<()> {
        let (store, host) = self.place(scope);
        Ok(store.delete_checklist(host, id)?)
    }

    /// Imports a JSON or Markdown checklist file; returns how many checklists it added.
    pub fn import(&self, scope: ChecklistScope, file_name: &str, text: &str) -> Result<usize> {
        let drafts = parse_checklist_file(file_name, text)?;
        let (store, host) = self.place(scope);
        Ok(store.add_checklists(host, drafts)?.len())
    }
}
