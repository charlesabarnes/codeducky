use crate::ids::Oid;
use crate::time::Timestamp;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
}

impl ChangeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Modified => "modified",
            Self::Deleted => "deleted",
        }
    }
}

/// One changed file of a review, as this crate needs it. A git layer maps its own diff model
/// onto this.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileChange {
    pub path: String,
    pub status: ChangeStatus,
    /// `None` when the file is absent on that side.
    pub old_oid: Option<Oid>,
    pub new_oid: Option<Oid>,
    /// Set for renames (status `Modified`): the path on the base side.
    pub old_path: Option<String>,
}

impl FileChange {
    pub fn new(path: impl Into<String>, old_oid: Option<&str>, new_oid: Option<&str>) -> Self {
        let status = match (old_oid, new_oid) {
            (None, _) => ChangeStatus::Added,
            (_, None) => ChangeStatus::Deleted,
            _ => ChangeStatus::Modified,
        };
        Self {
            path: path.into(),
            status,
            old_oid: old_oid.map(Oid::from),
            new_oid: new_oid.map(Oid::from),
            old_path: None,
        }
    }

    pub fn with_status(mut self, status: ChangeStatus) -> Self {
        self.status = status;
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileStats {
    Lines { additions: u32, deletions: u32 },
    Binary,
    TooLarge,
}

impl FileStats {
    pub fn changed_lines(self) -> u32 {
        match self {
            Self::Lines {
                additions,
                deletions,
            } => additions + deletions,
            Self::Binary | Self::TooLarge => 0,
        }
    }
}

/// One commit of a branch or pull request, as the commit picker lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchCommit {
    pub sha: String,
    pub parents: Vec<String>,
    /// The full message; the first line is the summary.
    pub message: String,
    pub author: String,
    pub date: Timestamp,
}

impl BranchCommit {
    pub fn summary(&self) -> &str {
        self.message.lines().next().unwrap_or("")
    }

    pub fn short_sha(&self) -> &str {
        short_sha(&self.sha)
    }

    pub fn is_merge(&self) -> bool {
        self.parents.len() > 1
    }
}

pub fn short_sha(sha: &str) -> &str {
    sha.get(..7).unwrap_or(sha)
}

impl AsRef<FileChange> for FileChange {
    fn as_ref(&self) -> &FileChange {
        self
    }
}
