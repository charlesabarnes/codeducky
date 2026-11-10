use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use ducky_git::{FileSide, Repo};
use ducky_github::pr_diff::BlobMeta;
use ducky_github::{BlobCache, Client, RepoRef};
use ducky_review::{FileChange, NumberedLine, Side, number_lines};

use crate::error::{Result, SessionError};
use crate::file_diff::MAX_TEXT_BYTES;

/// Where one side of a diff comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SideSource {
    /// The file is not there on this side.
    Absent,
    /// The file as of a commit.
    Rev(String),
    Worktree,
    /// A blob by id: the content you last reviewed, or a side of a pull request read from GitHub.
    Blob(String),
}

/// Where a review's file contents are read: a checkout through git, or a pull request's blobs
/// through the GitHub API.
#[derive(Clone)]
pub(crate) enum Content {
    Git(Repo),
    GitHub(Arc<PullBlobs>),
}

/// A pull request's blobs, fetched on demand and cached.
pub(crate) struct PullBlobs {
    pub client: Client,
    pub repo: RepoRef,
    cache: BlobCache,
    metas: Mutex<HashMap<String, BlobMeta>>,
    /// Blob ids of each changed file's old and new side in the pull request's diff.
    sides: HashMap<(String, Side), String>,
}

impl PullBlobs {
    pub fn new(
        client: Client,
        repo: RepoRef,
        metas: HashMap<String, BlobMeta>,
        changes: &[FileChange],
    ) -> Self {
        let mut sides = HashMap::new();
        for change in changes {
            let old_path = change.old_path.as_deref().unwrap_or(&change.path);
            if let Some(oid) = &change.old_oid {
                sides.insert((old_path.to_owned(), Side::Old), oid.as_str().to_owned());
            }
            if let Some(oid) = &change.new_oid {
                sides.insert((change.path.clone(), Side::New), oid.as_str().to_owned());
            }
        }
        Self {
            client,
            repo,
            cache: BlobCache::default(),
            metas: Mutex::new(metas),
            sides,
        }
    }

    pub fn add_metas(&self, metas: HashMap<String, BlobMeta>) {
        self.lock_metas().extend(metas);
    }

    fn lock_metas(&self) -> std::sync::MutexGuard<'_, HashMap<String, BlobMeta>> {
        self.metas.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn read(&self, oid: &str) -> Result<Option<FileSide>> {
        let metas = self.lock_metas().clone();
        Ok(ducky_github::pr_diff::read_side(
            Some(oid),
            &metas,
            MAX_TEXT_BYTES,
            |oid| {
                self.cache
                    .load(&self.client, &self.repo, oid)
                    .map(|bytes| bytes.to_vec())
            },
        )?)
    }

    pub fn side(&self, path: &str, side: Side) -> Result<Option<FileSide>> {
        match self.sides.get(&(path.to_owned(), side)) {
            Some(oid) => self.read(oid),
            None => Ok(None),
        }
    }
}

impl Content {
    pub fn repo(&self) -> Option<&Repo> {
        match self {
            Self::Git(repo) => Some(repo),
            Self::GitHub(_) => None,
        }
    }

    pub fn read(&self, source: &SideSource, path: &str) -> Result<Option<FileSide>> {
        match (self, source) {
            (_, SideSource::Absent) => Ok(None),
            (Self::Git(repo), SideSource::Rev(rev)) => {
                Ok(repo.side_at(rev, path, MAX_TEXT_BYTES)?)
            }
            (Self::Git(repo), SideSource::Worktree) => {
                Ok(repo.side_in_worktree(path, MAX_TEXT_BYTES)?)
            }
            (Self::Git(repo), SideSource::Blob(oid)) => Ok(Some(FileSide::from_bytes(
                &repo.read_blob(oid)?,
                MAX_TEXT_BYTES,
            ))),
            (Self::GitHub(blobs), SideSource::Blob(oid)) => blobs.read(oid),
            (Self::GitHub(_), _) => Err(SessionError::NeedsCheckout),
        }
    }

    /// One file side of the review's final diff: the base's copy (old) or the newest one.
    pub fn final_side(&self, base: &str, path: &str, side: Side) -> Result<Option<FileSide>> {
        match self {
            Self::Git(repo) => Ok(match side {
                Side::Old => repo.side_at(base, path, MAX_TEXT_BYTES)?,
                Side::New => repo.side_in_worktree(path, MAX_TEXT_BYTES)?,
            }),
            Self::GitHub(blobs) => blobs.side(path, side),
        }
    }
}

/// File sides' lines, each read once, for re-anchoring many notes.
pub(crate) struct SideLines<'a> {
    content: &'a Content,
    base: &'a str,
    cache: HashMap<(String, Side), Option<Arc<[NumberedLine]>>>,
}

impl<'a> SideLines<'a> {
    pub(crate) fn new(content: &'a Content, base: &'a str) -> Self {
        Self {
            content,
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
        let lines = match self.content.final_side(self.base, path, side)? {
            Some(FileSide::Text { text, .. }) => Some(Arc::from(number_lines(&text))),
            _ => None,
        };
        self.cache.insert(key, lines.clone());
        Ok(lines)
    }
}
