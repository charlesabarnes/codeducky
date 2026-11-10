use ducky_github::CompareStatus;
use ducky_review::last_look::{SinceCounts, SinceEntry, classify_since, count_since};
use ducky_review::{FileChange, ReviewState};

use crate::changes::ChangedFile;
use crate::error::Result;
use crate::sides::Content;

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
/// marking a file viewed stores its working-tree content there (see `NotesService`). A pull
/// request read from GitHub keeps its blobs there, so every reviewed version counts as present.
pub(crate) fn since_look(
    content: &Content,
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
    let present = match content {
        Content::Git(repo) => repo.existing_objects(&reviewed)?,
        Content::GitHub(_) => reviewed.iter().map(|oid| (*oid).to_owned()).collect(),
    };
    let changes: Vec<FileChange> = files.iter().map(|file| file.change.clone()).collect();
    let entries = classify_since(&changes, &looks, |oid| present.contains(oid.as_str()));
    let head_moved = match (&state.last_review, head) {
        (Some(last), Some(head)) if last.head != head => {
            let (commits, rewritten) = head_move(content, &last.head, head)?;
            Some(HeadMoved {
                from: last.head.clone(),
                to: head.to_owned(),
                commits,
                rewritten,
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

fn head_move(content: &Content, from: &str, to: &str) -> Result<(Option<usize>, bool)> {
    Ok(match content {
        Content::Git(repo) => {
            let moved = repo.head_move_since(from)?;
            (moved.commits, moved.rewritten)
        }
        Content::GitHub(blobs) => match blobs.client.compare(&blobs.repo, from, to) {
            Ok(c) if c.status == CompareStatus::Ahead && c.merge_base_sha == from => {
                (Some(c.ahead_by as usize), false)
            }
            _ => (None, true),
        },
    })
}
