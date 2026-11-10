use ducky_git::{ChangeStatus as GitStatus, FileKind, LineStats};
use ducky_review::order::{FileOrder, RiskInput, order_files};
use ducky_review::{ChangeStatus, FileChange, FileStats, Note};

/// The one-letter status the file list shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FileBadge {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Conflicted,
}

impl FileBadge {
    pub fn letter(self) -> &'static str {
        match self {
            Self::Added => "A",
            Self::Modified => "M",
            Self::Deleted => "D",
            Self::Renamed => "R",
            Self::Copied => "C",
            Self::TypeChanged => "T",
            Self::Conflicted => "U",
        }
    }
}

/// One changed file: git's view of it and the review layer's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangedFile {
    pub git: ducky_git::FileChange,
    pub change: FileChange,
    pub stats: Option<FileStats>,
}

impl ChangedFile {
    pub fn from_git(git: ducky_git::FileChange) -> Self {
        let status = match git.status {
            GitStatus::Added => ChangeStatus::Added,
            GitStatus::Deleted => ChangeStatus::Deleted,
            _ => ChangeStatus::Modified,
        };
        let old_path = match git.status {
            GitStatus::Renamed | GitStatus::Copied => git.old_path.clone(),
            _ => None,
        };
        let change = FileChange {
            path: git.path.clone(),
            status,
            old_oid: git.old_oid.as_deref().map(Into::into),
            new_oid: git.new_oid.as_deref().map(Into::into),
            old_path,
        };
        let stats = git.stats.map(|stats| match stats {
            LineStats::Text {
                additions,
                deletions,
            } => FileStats::Lines {
                additions: saturate(additions),
                deletions: saturate(deletions),
            },
            LineStats::Binary => FileStats::Binary,
        });
        Self { git, change, stats }
    }

    pub fn path(&self) -> &str {
        &self.change.path
    }

    /// The path on the base side: the old path of a rename or copy.
    pub fn base_path(&self) -> &str {
        self.change.old_path.as_deref().unwrap_or(&self.change.path)
    }

    pub fn badge(&self) -> FileBadge {
        match self.git.status {
            GitStatus::Added => FileBadge::Added,
            GitStatus::Modified => FileBadge::Modified,
            GitStatus::Deleted => FileBadge::Deleted,
            GitStatus::Renamed => FileBadge::Renamed,
            GitStatus::Copied => FileBadge::Copied,
            GitStatus::TypeChanged => FileBadge::TypeChanged,
            GitStatus::Unmerged => FileBadge::Conflicted,
        }
    }

    pub fn is_submodule(&self) -> bool {
        self.git.kind() == FileKind::Submodule
    }

    /// `(additions, deletions)` when git counted lines.
    pub fn line_counts(&self) -> Option<(u32, u32)> {
        match self.stats {
            Some(FileStats::Lines {
                additions,
                deletions,
            }) => Some((additions, deletions)),
            _ => None,
        }
    }
}

impl AsRef<FileChange> for ChangedFile {
    fn as_ref(&self) -> &FileChange {
        &self.change
    }
}

fn saturate(count: u64) -> u32 {
    u32::try_from(count).unwrap_or(u32::MAX)
}

struct Indexed<'a>(usize, &'a ChangedFile);

impl AsRef<FileChange> for Indexed<'_> {
    fn as_ref(&self) -> &FileChange {
        &self.1.change
    }
}

/// Indexes into `files` in review order. Risk counts each file's open notes.
pub fn order(files: &[ChangedFile], by: FileOrder, notes: &[Note]) -> Vec<usize> {
    let indexed: Vec<Indexed> = files
        .iter()
        .enumerate()
        .map(|(i, f)| Indexed(i, f))
        .collect();
    let open_notes = |file: &ChangedFile| {
        notes
            .iter()
            .filter(|note| note.is_open() && note.path == file.change.path)
            .count()
    };
    order_files(&indexed, by, |entry| RiskInput {
        stats: entry.1.stats,
        open_notes: open_notes(entry.1),
    })
    .into_iter()
    .map(|entry| entry.0)
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ducky_git::Mode;

    fn git_change(path: &str, status: GitStatus, old_path: Option<&str>) -> ducky_git::FileChange {
        ducky_git::FileChange {
            path: path.into(),
            old_path: old_path.map(str::to_owned),
            status,
            similarity: old_path.map(|_| 90),
            old_mode: (status != GitStatus::Added).then_some(Mode::FILE),
            new_mode: (status != GitStatus::Deleted).then_some(Mode::FILE),
            old_oid: (status != GitStatus::Added).then(|| "a".into()),
            new_oid: (status != GitStatus::Deleted).then(|| "b".into()),
            stats: Some(LineStats::Text {
                additions: 3,
                deletions: 1,
            }),
            untracked: false,
        }
    }

    #[test]
    fn maps_renames_onto_modified_with_the_old_path() {
        let file = ChangedFile::from_git(git_change("b.rs", GitStatus::Renamed, Some("a.rs")));
        assert_eq!(file.change.status, ChangeStatus::Modified);
        assert_eq!(file.change.old_path.as_deref(), Some("a.rs"));
        assert_eq!(file.base_path(), "a.rs");
        assert_eq!(file.badge().letter(), "R");
        assert_eq!(file.line_counts(), Some((3, 1)));
    }

    #[test]
    fn orders_by_folder_then_by_risk() {
        let files: Vec<ChangedFile> = [
            ("src/z.rs", GitStatus::Modified),
            ("Cargo.lock", GitStatus::Modified),
            ("src/auth/login.rs", GitStatus::Added),
        ]
        .into_iter()
        .map(|(path, status)| ChangedFile::from_git(git_change(path, status, None)))
        .collect();
        let paths = |order: Vec<usize>| -> Vec<&str> {
            order.into_iter().map(|i| files[i].path()).collect()
        };
        assert_eq!(
            paths(order(&files, FileOrder::Folders, &[])),
            ["src/auth/login.rs", "src/z.rs", "Cargo.lock"]
        );
        assert_eq!(paths(order(&files, FileOrder::Risk, &[]))[2], "Cargo.lock");
    }
}
