use std::collections::HashMap;
use std::sync::Arc;

use ducky_git::{FileSide, Repo};
use ducky_review::{NumberedLine, Side, number_lines};

use crate::error::Result;
use crate::file_diff::MAX_TEXT_BYTES;

/// Where one side of a diff comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SideSource {
    /// The file is not there on this side.
    Absent,
    /// The file as of a commit.
    Rev(String),
    Worktree,
    /// A blob by id: the content you last reviewed.
    Blob(String),
}

pub(crate) fn read_source(
    repo: &Repo,
    source: &SideSource,
    path: &str,
) -> Result<Option<FileSide>> {
    Ok(match source {
        SideSource::Absent => None,
        SideSource::Rev(rev) => repo.side_at(rev, path, MAX_TEXT_BYTES)?,
        SideSource::Worktree => repo.side_in_worktree(path, MAX_TEXT_BYTES)?,
        SideSource::Blob(oid) => Some(FileSide::from_bytes(&repo.read_blob(oid)?, MAX_TEXT_BYTES)),
    })
}

/// One file side: the base commit's copy (old) or the working tree's (new).
pub(crate) fn read_side(
    repo: &Repo,
    base: &str,
    path: &str,
    side: Side,
) -> Result<Option<FileSide>> {
    Ok(match side {
        Side::Old => repo.side_at(base, path, MAX_TEXT_BYTES)?,
        Side::New => repo.side_in_worktree(path, MAX_TEXT_BYTES)?,
    })
}

/// File sides' lines, each read once, for re-anchoring many notes.
pub(crate) struct SideLines<'a> {
    repo: &'a Repo,
    base: &'a str,
    cache: HashMap<(String, Side), Option<Arc<[NumberedLine]>>>,
}

impl<'a> SideLines<'a> {
    pub(crate) fn new(repo: &'a Repo, base: &'a str) -> Self {
        Self {
            repo,
            base,
            cache: HashMap::new(),
        }
    }

    /// `None` when the side is missing, binary or too large: a note there has lost its anchor.
    pub(crate) fn lines(&mut self, path: &str, side: Side) -> Result<Option<Arc<[NumberedLine]>>> {
        let key = (path.to_owned(), side);
        if let Some(lines) = self.cache.get(&key) {
            return Ok(lines.clone());
        }
        let lines = match read_side(self.repo, self.base, path, side)? {
            Some(FileSide::Text { text, .. }) => Some(Arc::from(number_lines(&text))),
            _ => None,
        };
        self.cache.insert(key, lines.clone());
        Ok(lines)
    }
}
