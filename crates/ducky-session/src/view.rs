use ducky_review::commit_range::CommitRange;
use ducky_review::last_look::SinceKind;
use ducky_review::view_notes::NoteView;
use ducky_review::{BranchCommit, ChangeStatus};

use crate::changes::ChangedFile;
use crate::error::{Result, SessionError};
use crate::file_diff::{DiffOptions, FileDiff, branch_sides, load_between};
use crate::review::Review;
use crate::sides::SideSource;

/// What the review shows: everything on the branch, what changed since your last look, or
/// some of its commits (held by sha, so a pick survives a reload).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ReviewMode {
    #[default]
    All,
    Since,
    Commits {
        from: String,
        to: String,
    },
}

impl ReviewMode {
    pub fn commits(range: CommitRange, commits: &[BranchCommit]) -> Option<Self> {
        Some(Self::Commits {
            from: commits.get(range.from)?.sha.clone(),
            to: commits.get(range.to)?.sha.clone(),
        })
    }

    pub fn is_commits(&self) -> bool {
        matches!(self, Self::Commits { .. })
    }
}

/// One file as a mode shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewEntry {
    /// The change on screen: the branch's, or the commit range's.
    pub file: ChangedFile,
    pub old: SideSource,
    pub new: SideSource,
    pub since: Option<SinceKind>,
    pub note_view: NoteView,
    /// The file is in the branch's final diff, so it can be marked viewed.
    pub in_final: bool,
    /// The new side is the working tree, so the file can be edited from here.
    pub shows_worktree: bool,
}

/// The commits a commit mode covers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitScope {
    pub range: CommitRange,
    pub label: String,
    /// The first commit's first parent; `None` for a root commit.
    pub base: Option<String>,
    pub head: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewView {
    pub mode: ReviewMode,
    pub entries: Vec<ViewEntry>,
    pub commit: Option<CommitScope>,
}

impl ReviewView {
    pub fn entry(&self, path: &str) -> Option<&ViewEntry> {
        self.entries.iter().find(|entry| entry.file.path() == path)
    }

    pub fn files(&self) -> Vec<ChangedFile> {
        self.entries
            .iter()
            .map(|entry| entry.file.clone())
            .collect()
    }
}

impl Review {
    /// Blocks for commit modes, which ask git what the range changed.
    pub fn view(&self, mode: &ReviewMode) -> Result<ReviewView> {
        let (entries, commit) = match mode {
            ReviewMode::All => (self.all_entries(), None),
            ReviewMode::Since => (self.since_entries(), None),
            ReviewMode::Commits { from, to } => {
                let range =
                    CommitRange::find(&self.commits, from, to).ok_or(SessionError::CommitsGone)?;
                let (entries, scope) = self.commit_entries(range)?;
                (entries, Some(scope))
            }
        };
        Ok(ReviewView {
            mode: mode.clone(),
            entries,
            commit,
        })
    }

    pub fn load_entry_diff(&self, entry: &ViewEntry, options: DiffOptions) -> Result<FileDiff> {
        load_between(&self.repo, &entry.file, &entry.old, &entry.new, options)
    }

    fn branch_entry(&self, file: &ChangedFile) -> ViewEntry {
        let (old, new) = branch_sides(file, &self.merge_base);
        ViewEntry {
            shows_worktree: new == SideSource::Worktree,
            file: file.clone(),
            old,
            new,
            since: None,
            note_view: NoteView::All,
            in_final: true,
        }
    }

    fn all_entries(&self) -> Vec<ViewEntry> {
        self.files
            .iter()
            .map(|file| self.branch_entry(file))
            .collect()
    }

    /// Changed files show the interdiff from what you reviewed; the rest show the branch diff.
    fn since_entries(&self) -> Vec<ViewEntry> {
        self.files
            .iter()
            .map(|file| {
                let mut entry = self.branch_entry(file);
                let Some(since) = self.since.as_ref().and_then(|s| s.entry(file.path())) else {
                    return entry;
                };
                entry.since = Some(since.kind);
                if since.kind == SinceKind::Changed {
                    entry.old = match &since.change.old_oid {
                        Some(oid) => SideSource::Blob(oid.as_str().to_owned()),
                        None => SideSource::Absent,
                    };
                    entry.note_view = NoteView::Interdiff;
                }
                entry
            })
            .collect()
    }

    fn commit_entries(&self, range: CommitRange) -> Result<(Vec<ViewEntry>, CommitScope)> {
        let ends = range
            .ends(&self.commits)
            .map_err(|_| SessionError::CommitsGone)?;
        let changes = self
            .repo
            .changes_between(ends.base.as_deref(), &ends.head)?;
        let entries = changes
            .into_iter()
            .map(ChangedFile::from_git)
            .map(|file| {
                let old = match (&ends.base, file.change.status) {
                    (Some(base), status) if status != ChangeStatus::Added => {
                        SideSource::Rev(base.clone())
                    }
                    _ => SideSource::Absent,
                };
                let new = match file.change.status {
                    ChangeStatus::Deleted => SideSource::Absent,
                    _ => SideSource::Rev(ends.head.clone()),
                };
                ViewEntry {
                    in_final: self.file_index(file.path()).is_some(),
                    file,
                    old,
                    new,
                    since: None,
                    note_view: NoteView::Commit {
                        sha: ends.head.clone(),
                    },
                    shows_worktree: false,
                }
            })
            .collect();
        let scope = CommitScope {
            range,
            label: range.describe(&self.commits),
            base: ends.base,
            head: ends.head,
        };
        Ok((entries, scope))
    }
}
