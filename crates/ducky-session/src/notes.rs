use std::collections::HashMap;
use std::sync::Arc;

use ducky_git::Repo;
use ducky_host::Host;
use ducky_notes::ReviewNotes;
use ducky_review::view_notes::{NoteView, ShownLines, anchor_for_view};
use ducky_review::{
    Author, ChangeStatus, ChecklistItemId, FileChange, NewNote, Note, NoteEdit, NoteId,
    NumberedLine, ReviewState, Severity, Side, create_anchor, reanchor_notes,
};

use crate::changes::ChangedFile;
use crate::error::Result;
use crate::sides::SideLines;

/// A note being made on a line or a range of one side.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteDraft {
    pub path: String,
    pub side: Side,
    pub line: u32,
    pub end_line: Option<u32>,
    pub body: String,
    pub severity: Severity,
}

/// One review's notes and state files, on the machine that holds the repository.
#[derive(Clone)]
pub struct NotesService {
    host: Arc<dyn Host>,
    store: ReviewNotes,
    repo: Repo,
    base: String,
    head: Option<String>,
    readme_path: String,
}

impl NotesService {
    pub(crate) fn new(
        repo: Repo,
        store: ReviewNotes,
        base: String,
        head: Option<String>,
        readme_path: String,
    ) -> Self {
        Self {
            host: repo.host().clone(),
            store,
            repo,
            base,
            head,
            readme_path,
        }
    }

    pub fn notes_path(&self) -> String {
        self.store.notes_path()
    }

    /// The README beside the notes that tells an agent how to edit them.
    pub fn readme_path(&self) -> String {
        self.readme_path.clone()
    }

    pub fn target(&self) -> &ducky_review::ReviewTarget {
        self.store.target()
    }

    /// Creates `notes.json` and the README when missing, so a prompt can point at them.
    /// Skipped when both exist, so it never rewrites a notes file an agent may be editing.
    pub fn ensure_files(&self) -> Result<()> {
        let exists = |path: &str| self.host.read_file(path).is_ok();
        if !exists(&self.readme_path) || !exists(&self.notes_path()) {
            self.store.insert_notes(&*self.host, Vec::new())?;
        }
        Ok(())
    }

    pub fn notes(&self) -> Result<Vec<Note>> {
        Ok(self.store.notes(&*self.host)?)
    }

    pub fn state(&self) -> Result<ReviewState> {
        Ok(self.store.state(&*self.host)?)
    }

    /// `lines` are the side's numbered lines as shown, to capture the code and its context.
    pub fn add(&self, draft: NoteDraft, lines: &[NumberedLine]) -> Result<Note> {
        let anchor = create_anchor(lines, draft.line, draft.side, draft.end_line)?;
        let mut new = NewNote::new(draft.path, anchor, draft.body);
        new.severity = draft.severity;
        new.author = Author::Human;
        Ok(self.store.add_note(&*self.host, new)?)
    }

    pub fn edit(&self, id: &NoteId, body: String, severity: Severity) -> Result<Note> {
        let edit = NoteEdit {
            body: Some(body),
            severity: Some(severity),
        };
        Ok(self.store.edit_note(&*self.host, id, edit)?)
    }

    pub fn resolve(&self, id: &NoteId) -> Result<Note> {
        Ok(self
            .store
            .resolve_note(&*self.host, id, Author::Human, None)?)
    }

    pub fn dismiss(&self, id: &NoteId) -> Result<Note> {
        Ok(self
            .store
            .dismiss_note(&*self.host, id, Author::Human, None)?)
    }

    pub fn reopen(&self, id: &NoteId) -> Result<Note> {
        Ok(self.store.reopen_note(&*self.host, id)?)
    }

    pub fn delete(&self, id: &NoteId) -> Result<()> {
        Ok(self.store.delete_note(&*self.host, id)?)
    }

    /// Marking a file viewed records the head and keeps its working-tree content in the object
    /// database, so "since last look" can diff from it after it changes.
    pub fn mark_viewed(&self, file: &ChangedFile, viewed: bool) -> Result<ReviewState> {
        if viewed {
            self.store_reviewed(std::slice::from_ref(file));
        }
        let head = self.head.as_deref().filter(|_| viewed);
        Ok(self
            .store
            .mark_viewed(&*self.host, &file.change, viewed, head)?)
    }

    /// Records every file as reviewed at the current head: "since last look" starts here.
    pub fn mark_reviewed(&self, files: &[ChangedFile]) -> Result<ReviewState> {
        self.store_reviewed(files);
        let changes: Vec<FileChange> = files.iter().map(|file| file.change.clone()).collect();
        let head = self.head.as_deref().unwrap_or_default();
        Ok(self
            .store
            .record_reviewed_files(&*self.host, head, &changes)?)
    }

    /// Best effort: a file that cannot be stored (gone meanwhile) later shows its full diff,
    /// with the reason, instead of an interdiff.
    fn store_reviewed(&self, files: &[ChangedFile]) {
        let paths: Vec<&str> = files
            .iter()
            .filter(|file| {
                file.change.status != ChangeStatus::Deleted
                    && file.git.kind() == ducky_git::FileKind::File
            })
            .map(ChangedFile::path)
            .collect();
        if self.repo.store_worktree_blobs(&paths).is_err() {
            for path in paths {
                self.repo.store_worktree_blobs(&[path]).ok();
            }
        }
    }

    pub fn set_checked(&self, item: &ChecklistItemId, checked: bool) -> Result<ReviewState> {
        Ok(self.store.set_checked(&*self.host, item, checked)?)
    }

    /// A note made on the diff of `view`: in commit mode it is anchored on the final content
    /// while its line survives there, else pinned to the commit.
    pub fn add_in_view(
        &self,
        draft: NoteDraft,
        view: &NoteView,
        shown: ShownLines,
    ) -> Result<Note> {
        let final_lines = match view {
            NoteView::Commit { .. } => {
                SideLines::new(&self.repo, &self.base).lines(&draft.path, Side::New)?
            }
            _ => None,
        };
        let placed = anchor_for_view(
            view,
            draft.side,
            draft.line,
            draft.end_line,
            shown,
            final_lines.as_deref(),
        )?;
        let mut new = NewNote::new(draft.path, placed.anchor, draft.body);
        new.severity = draft.severity;
        new.author = Author::Human;
        new.commit = placed.commit;
        Ok(self.store.add_note(&*self.host, new)?)
    }

    /// Finds every note's code again in the current content and writes down what moved.
    /// A note on a file that was renamed since follows it to the new path. Returns how many
    /// notes changed.
    pub fn reanchor(&self, files: &[ChangedFile]) -> Result<usize> {
        let notes = self.notes()?;
        let moved = self.follow_renames(&notes, files)?;
        let notes = if moved > 0 { self.notes()? } else { notes };
        let base_paths: HashMap<&str, &str> = files
            .iter()
            .map(|file| (file.path(), file.base_path()))
            .collect();
        let mut sides = SideLines::new(&self.repo, &self.base);
        let mut failure = None;
        let updates = reanchor_notes(&notes, |path, side| {
            let path = match side {
                Side::Old => base_paths.get(path).copied().unwrap_or(path),
                Side::New => path,
            };
            sides.lines(path, side).unwrap_or_else(|error| {
                failure.get_or_insert(error);
                None
            })
        });
        if let Some(error) = failure {
            return Err(error);
        }
        self.store.apply_reanchoring(&*self.host, &updates)?;
        Ok(moved + updates.len())
    }

    /// Notes made on `a.rs` before it became `b.rs` move to `b.rs`; their old-side lines are
    /// then read from `a.rs` in the base, their new-side lines from `b.rs`.
    fn follow_renames(&self, notes: &[Note], files: &[ChangedFile]) -> Result<usize> {
        let renamed: HashMap<&str, &str> = files
            .iter()
            .filter_map(|file| Some((file.change.old_path.as_deref()?, file.path())))
            .collect();
        let current: std::collections::HashSet<&str> =
            files.iter().map(ChangedFile::path).collect();
        let mut moved = 0;
        for note in notes {
            if note.commit.is_some() || current.contains(note.path.as_str()) {
                continue;
            }
            if let Some(&to) = renamed.get(note.path.as_str()) {
                self.store.modify_note(&*self.host, &note.id, |note, _| {
                    note.path = to.to_owned();
                })?;
                moved += 1;
            }
        }
        Ok(moved)
    }
}
