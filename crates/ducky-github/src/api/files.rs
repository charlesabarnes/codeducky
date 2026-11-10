use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Removed,
    Modified,
    Renamed,
    Copied,
    Changed,
    Unchanged,
}

/// One file of a pull request or comparison, as GitHub lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullFile {
    pub path: String,
    pub previous_path: Option<String>,
    pub status: FileStatus,
    /// Absent for binary files and very large diffs.
    pub patch: Option<String>,
    /// Blob of the head version; for removed files GitHub may send the base blob or nothing.
    pub sha: Option<String>,
    pub additions: u32,
    pub deletions: u32,
}

impl PullFile {
    pub fn new(path: impl Into<String>, status: FileStatus, patch: Option<&str>) -> Self {
        Self {
            path: path.into(),
            previous_path: None,
            status,
            patch: patch.map(str::to_owned),
            sha: None,
            additions: 0,
            deletions: 0,
        }
    }

    /// The path on the base side.
    pub fn old_path(&self) -> &str {
        match (&self.status, &self.previous_path) {
            (FileStatus::Renamed, Some(previous)) => previous,
            _ => &self.path,
        }
    }

    pub fn has_old(&self) -> bool {
        !matches!(self.status, FileStatus::Added | FileStatus::Copied)
    }

    pub fn has_new(&self) -> bool {
        self.status != FileStatus::Removed
    }
}

#[derive(Deserialize)]
pub(crate) struct RawFile {
    filename: String,
    previous_filename: Option<String>,
    status: FileStatus,
    sha: Option<String>,
    patch: Option<String>,
    #[serde(default)]
    additions: u32,
    #[serde(default)]
    deletions: u32,
}

impl From<RawFile> for PullFile {
    fn from(raw: RawFile) -> Self {
        Self {
            path: raw.filename,
            previous_path: raw.previous_filename,
            status: raw.status,
            patch: raw.patch,
            sha: raw.sha,
            additions: raw.additions,
            deletions: raw.deletions,
        }
    }
}
