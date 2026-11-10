use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use ducky_host::Host;
use ducky_review::checklist::{Checklist, ChecklistDraft};
use ducky_review::{
    Author, ChecklistId, ChecklistItemId, FileChange, GithubComment, NewNote, Note, NoteEdit,
    NoteId, NoteUpdate, ReviewState, ReviewTarget, Timestamp,
};

use crate::checklists_file::ChecklistsDocument;
use crate::document::{self, Document};
use crate::error::NotesError;
use crate::ids::fresh_id;
use crate::layout::{self, CHECKLISTS, FOLDER, NOTES, README, STATE};
use crate::merge::merge_notes;
use crate::notes_file::NotesDocument;
use crate::record::Record;
use crate::state_file::StateDocument;

const README_TEXT: &str = include_str!("readme.md");

/// The `codeducky` folder of one repository, on whichever machine holds it.
#[derive(Debug, Clone)]
pub struct NotesRepo {
    root: String,
    clock: fn() -> Timestamp,
    readme_checked: Arc<AtomicBool>,
}

impl NotesRepo {
    /// The folder at `root` itself, e.g. for a pull request reviewed without a local clone.
    pub fn at(root: impl Into<String>) -> Self {
        Self {
            root: root.into(),
            clock: Timestamp::now,
            readme_checked: Arc::default(),
        }
    }

    /// `<git common dir>/codeducky`.
    pub fn in_git_dir(git_common_dir: &str) -> Self {
        Self::at(layout::join(git_common_dir, FOLDER))
    }

    /// Finds the git common dir of the checkout at `repo` and uses its `codeducky` folder.
    pub fn open(host: &dyn Host, repo: &str) -> Result<Self, NotesError> {
        Ok(Self::in_git_dir(&layout::git_common_dir(host, repo)?))
    }

    /// Replaces the clock that stamps `created_at`, `updated_at` and review times.
    pub fn with_clock(mut self, clock: fn() -> Timestamp) -> Self {
        self.clock = clock;
        self
    }

    pub fn root(&self) -> &str {
        &self.root
    }

    pub fn readme_path(&self) -> String {
        layout::join(&self.root, README)
    }

    pub fn checklists_path(&self) -> String {
        layout::join(&self.root, CHECKLISTS)
    }

    pub fn review(&self, target: ReviewTarget) -> Result<ReviewNotes, NotesError> {
        let dir = layout::review_dir(&self.root, &target)?;
        Ok(ReviewNotes {
            repo: self.clone(),
            target,
            dir,
        })
    }

    fn now(&self) -> Timestamp {
        (self.clock)()
    }

    /// Puts the README for agents beside the files on their first write, and refreshes it when
    /// this build's text differs.
    fn ensure_readme(&self, host: &dyn Host) -> Result<(), NotesError> {
        if self.readme_checked.load(Ordering::Relaxed) {
            return Ok(());
        }
        let path = self.readme_path();
        if document::read_bytes(host, &path)?.as_deref() != Some(README_TEXT.as_bytes()) {
            host.write_file(&path, README_TEXT.as_bytes())?;
        }
        self.readme_checked.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn update<D: Document, R>(
        &self,
        host: &dyn Host,
        path: &str,
        empty: impl Fn() -> D,
        change: impl FnMut(&mut D) -> Result<R, NotesError>,
    ) -> Result<R, NotesError> {
        let (result, wrote) = document::update(host, path, empty, change)?;
        if wrote {
            self.ensure_readme(host)?;
        }
        Ok(result)
    }

    pub fn checklists(&self, host: &dyn Host) -> Result<Vec<Checklist>, NotesError> {
        let file: ChecklistsDocument =
            document::load(host, &self.checklists_path(), ChecklistsDocument::default)?;
        Ok(file
            .checklists
            .into_iter()
            .map(|record| record.value)
            .collect())
    }

    pub fn add_checklists(
        &self,
        host: &dyn Host,
        drafts: Vec<ChecklistDraft>,
    ) -> Result<Vec<Checklist>, NotesError> {
        self.update(
            host,
            &self.checklists_path(),
            ChecklistsDocument::default,
            |file| {
                let mut added = Vec::new();
                for draft in drafts.iter().cloned() {
                    let checklist = Checklist::from_draft(draft, || {
                        fresh_id(|id| {
                            file.checklists.iter().any(|record| {
                                let list = &record.value;
                                list.id.as_str() == id
                                    || list.items.iter().any(|item| item.id.as_str() == id)
                            })
                        })
                    });
                    file.checklists.push(Record::new(checklist.clone()));
                    added.push(checklist);
                }
                Ok(added)
            },
        )
    }

    /// Replaces the checklist with the same id, or adds it.
    pub fn save_checklist(&self, host: &dyn Host, checklist: Checklist) -> Result<(), NotesError> {
        self.update(
            host,
            &self.checklists_path(),
            ChecklistsDocument::default,
            |file| {
                match file
                    .checklists
                    .iter_mut()
                    .find(|record| record.value.id == checklist.id)
                {
                    Some(record) => record.value = checklist.clone(),
                    None => file.checklists.push(Record::new(checklist.clone())),
                }
                Ok(())
            },
        )
    }

    pub fn delete_checklist(&self, host: &dyn Host, id: &ChecklistId) -> Result<(), NotesError> {
        self.update(
            host,
            &self.checklists_path(),
            ChecklistsDocument::default,
            |file| {
                let before = file.checklists.len();
                file.checklists.retain(|record| record.value.id != *id);
                if file.checklists.len() == before {
                    return Err(NotesError::ChecklistNotFound(id.to_string()));
                }
                Ok(())
            },
        )
    }
}

/// One review's files: `notes.json` and `state.json` in `branches/<branch>/` or `pulls/<number>/`.
#[derive(Debug, Clone)]
pub struct ReviewNotes {
    repo: NotesRepo,
    target: ReviewTarget,
    dir: String,
}

impl ReviewNotes {
    pub fn target(&self) -> &ReviewTarget {
        &self.target
    }

    pub fn notes_path(&self) -> String {
        layout::join(&self.dir, NOTES)
    }

    pub fn state_path(&self) -> String {
        layout::join(&self.dir, STATE)
    }

    fn check_target(&self, found: &mut Option<ReviewTarget>, path: &str) -> Result<(), NotesError> {
        match found {
            Some(found) if *found != self.target => Err(NotesError::WrongTarget {
                path: path.to_owned(),
                expected: self.target.clone(),
                found: found.clone(),
            }),
            Some(_) => Ok(()),
            None => {
                *found = Some(self.target.clone());
                Ok(())
            }
        }
    }

    fn notes_file(&self, host: &dyn Host) -> Result<NotesDocument, NotesError> {
        let path = self.notes_path();
        let mut file = document::load(host, &path, || NotesDocument::new(self.target.clone()))?;
        self.check_target(&mut file.target, &path)?;
        Ok(file)
    }

    /// Changes `notes.json` against a fresh read of it. Hand-added notes get their missing
    /// timestamps here, so they are written down with the change.
    fn update_notes<R>(
        &self,
        host: &dyn Host,
        mut change: impl FnMut(&mut NotesDocument, Timestamp) -> Result<R, NotesError>,
    ) -> Result<R, NotesError> {
        let path = self.notes_path();
        let now = self.repo.now();
        self.repo.update(
            host,
            &path,
            || NotesDocument::new(self.target.clone()),
            |file| {
                self.check_target(&mut file.target, &path)?;
                for note in file.notes.iter_mut().map(|record| &mut record.value) {
                    fill_timestamps(note, now);
                }
                change(file, now)
            },
        )
    }

    pub fn notes(&self, host: &dyn Host) -> Result<Vec<Note>, NotesError> {
        Ok(self.notes_file(host)?.notes())
    }

    pub fn note(&self, host: &dyn Host, id: &NoteId) -> Result<Note, NotesError> {
        self.notes(host)?
            .into_iter()
            .find(|note| note.id == *id)
            .ok_or_else(|| NotesError::NoteNotFound(id.clone()))
    }

    pub fn add_note(&self, host: &dyn Host, new: NewNote) -> Result<Note, NotesError> {
        self.update_notes(host, |file, now| {
            let id = fresh_id(|id| {
                file.notes
                    .iter()
                    .any(|record| record.value.id.as_str() == id)
            });
            let note = new.clone().into_note(NoteId::new(id), now);
            file.notes.push(Record::new(note.clone()));
            Ok(note)
        })
    }

    /// Adds whole notes, e.g. carried over from another review; an id already in use is replaced.
    pub fn insert_notes(&self, host: &dyn Host, notes: Vec<Note>) -> Result<Vec<Note>, NotesError> {
        self.update_notes(host, |file, _| {
            let mut inserted = Vec::with_capacity(notes.len());
            for mut note in notes.iter().cloned() {
                let taken = |id: &str| {
                    file.notes
                        .iter()
                        .any(|record| record.value.id.as_str() == id)
                };
                if note.id.is_empty() || taken(note.id.as_str()) {
                    note.id = NoteId::new(fresh_id(taken));
                }
                file.notes.push(Record::new(note.clone()));
                inserted.push(note);
            }
            Ok(inserted)
        })
    }

    /// Applies `change` to one note, read fresh from disk, and stamps its `updated_at`.
    pub fn modify_note(
        &self,
        host: &dyn Host,
        id: &NoteId,
        mut change: impl FnMut(&mut Note, Timestamp),
    ) -> Result<Note, NotesError> {
        self.update_notes(host, |file, now| {
            let note = file
                .find_mut(id)
                .ok_or_else(|| NotesError::NoteNotFound(id.clone()))?;
            change(note, now);
            note.updated_at = now;
            Ok(note.clone())
        })
    }

    pub fn edit_note(
        &self,
        host: &dyn Host,
        id: &NoteId,
        edit: NoteEdit,
    ) -> Result<Note, NotesError> {
        self.modify_note(host, id, |note, now| note.edit(edit.clone(), now))
    }

    pub fn resolve_note(
        &self,
        host: &dyn Host,
        id: &NoteId,
        by: Author,
        text: Option<String>,
    ) -> Result<Note, NotesError> {
        self.modify_note(host, id, |note, now| {
            note.resolve(by.clone(), text.clone(), now)
        })
    }

    pub fn dismiss_note(
        &self,
        host: &dyn Host,
        id: &NoteId,
        by: Author,
        text: Option<String>,
    ) -> Result<Note, NotesError> {
        self.modify_note(host, id, |note, now| {
            note.dismiss(by.clone(), text.clone(), now)
        })
    }

    pub fn reopen_note(&self, host: &dyn Host, id: &NoteId) -> Result<Note, NotesError> {
        self.modify_note(host, id, |note, now| note.reopen(now))
    }

    /// Records the GitHub review comment a note was pushed as.
    pub fn link_github_comment(
        &self,
        host: &dyn Host,
        id: &NoteId,
        comment: GithubComment,
    ) -> Result<Note, NotesError> {
        self.modify_note(host, id, |note, _| note.github = Some(comment.clone()))
    }

    pub fn delete_note(&self, host: &dyn Host, id: &NoteId) -> Result<(), NotesError> {
        self.update_notes(host, |file, _| {
            let before = file.notes.len();
            file.notes.retain(|record| record.value.id != *id);
            if file.notes.len() == before {
                return Err(NotesError::NoteNotFound(id.clone()));
            }
            Ok(())
        })
    }

    /// Writes re-anchored positions. Not an edit of the note, so `updated_at` stays; notes
    /// deleted meanwhile are skipped.
    pub fn apply_reanchoring(
        &self,
        host: &dyn Host,
        updates: &[NoteUpdate],
    ) -> Result<(), NotesError> {
        if updates.is_empty() {
            return Ok(());
        }
        self.update_notes(host, |file, _| {
            for update in updates {
                if let Some(note) = file.find_mut(&update.id) {
                    note.apply_update(update);
                }
            }
            Ok(())
        })
    }

    /// Saves a whole set of notes held in memory: `base` is what was loaded, `ours` the set now.
    /// Merged per note with the file as it is now (see [`merge_notes`]); returns the result.
    pub fn save_notes(
        &self,
        host: &dyn Host,
        base: &[Note],
        ours: &[Note],
    ) -> Result<Vec<Note>, NotesError> {
        self.update_notes(host, |file, _| {
            file.notes = merge_notes(base, ours, std::mem::take(&mut file.notes));
            Ok(file.notes())
        })
    }

    pub fn state(&self, host: &dyn Host) -> Result<ReviewState, NotesError> {
        let path = self.state_path();
        let mut file = document::load(host, &path, || StateDocument::new(self.target.clone()))?;
        self.check_target(&mut file.target, &path)?;
        Ok(file.state.value)
    }

    /// Changes `state.json` against a fresh read of it and returns the new state.
    pub fn update_state(
        &self,
        host: &dyn Host,
        mut change: impl FnMut(&mut ReviewState, Timestamp),
    ) -> Result<ReviewState, NotesError> {
        let path = self.state_path();
        let now = self.repo.now();
        self.repo.update(
            host,
            &path,
            || StateDocument::new(self.target.clone()),
            |file| {
                self.check_target(&mut file.target, &path)?;
                let state = &mut file.state.value;
                state.started_at.get_or_insert(now);
                change(state, now);
                Ok(state.clone())
            },
        )
    }

    pub fn mark_viewed(
        &self,
        host: &dyn Host,
        change: &FileChange,
        viewed: bool,
        head: Option<&str>,
    ) -> Result<ReviewState, NotesError> {
        self.update_state(host, |state, now| {
            state.mark_viewed(change, viewed, head, now)
        })
    }

    pub fn record_review_head(
        &self,
        host: &dyn Host,
        path: &str,
        head: &str,
    ) -> Result<ReviewState, NotesError> {
        self.update_state(host, |state, now| state.record_review_head(path, head, now))
    }

    pub fn record_reviewed_files(
        &self,
        host: &dyn Host,
        head: &str,
        files: &[FileChange],
    ) -> Result<ReviewState, NotesError> {
        self.update_state(host, |state, now| {
            state.record_reviewed_files(head, files, now)
        })
    }

    pub fn set_checked(
        &self,
        host: &dyn Host,
        item: &ChecklistItemId,
        checked: bool,
    ) -> Result<ReviewState, NotesError> {
        self.update_state(host, |state, _| state.set_checked(item.clone(), checked))
    }
}

fn fill_timestamps(note: &mut Note, now: Timestamp) {
    let unset = Timestamp::default();
    if note.updated_at == unset {
        note.updated_at = if note.created_at == unset {
            now
        } else {
            note.created_at
        };
    }
    if note.created_at == unset {
        note.created_at = note.updated_at;
    }
}
