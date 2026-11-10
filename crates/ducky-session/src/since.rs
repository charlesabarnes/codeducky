use ducky_git::Repo;
use ducky_review::last_look::{SinceCounts, SinceEntry, classify_since, count_since};
use ducky_review::{FileChange, ReviewState};

use crate::changes::ChangedFile;
use crate::error::Result;

/// How HEAD moved since the last recorded review.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadMoved {
    pub from: String,
    pub to: String,
    /// Commits on top of the reviewed head; `None` when history was rewritten.
    pub commits: Option<usize>,
    pub rewritten: bool,
}

/// What changed since you last looked at each file, in the review's file order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SinceLook {
    pub entries: Vec<SinceEntry>,
    pub counts: SinceCounts,
    pub head_moved: Option<HeadMoved>,
}

impl SinceLook {
    /// Files worth a look: changed, new, or changed with the reviewed version gone.
    pub fn to_review(&self) -> usize {
        self.counts.changed + self.counts.missing + self.counts.fresh
    }

    pub fn entry(&self, path: &str) -> Option<&SinceEntry> {
        self.entries
            .iter()
            .find(|entry| entry.original.path == path)
    }
}

/// `None` until some file was looked at. Reviewed versions are read from the object database;
/// marking a file viewed stores its working-tree content there (see `NotesService`).
pub fn since_look(
    repo: &Repo,
    files: &[ChangedFile],
    state: &ReviewState,
    head: Option<&str>,
) -> Result<Option<SinceLook>> {
    let looks = state.last_looks();
    if looks.is_empty() {
        return Ok(None);
    }
    let reviewed: Vec<&str> = looks
        .values()
        .filter_map(|look| look.oid.as_ref().map(|oid| oid.as_str()))
        .collect();
    let present = repo.existing_objects(&reviewed)?;
    let changes: Vec<FileChange> = files.iter().map(|file| file.change.clone()).collect();
    let entries = classify_since(&changes, &looks, |oid| present.contains(oid.as_str()));
    let head_moved = match (&state.last_review, head) {
        (Some(last), Some(head)) if last.head != head => {
            let moved = repo.head_move_since(&last.head)?;
            Some(HeadMoved {
                from: last.head.clone(),
                to: head.to_owned(),
                commits: moved.commits,
                rewritten: moved.rewritten,
            })
        }
        _ => None,
    };
    Ok(Some(SinceLook {
        counts: count_since(&entries),
        entries,
        head_moved,
    }))
}
