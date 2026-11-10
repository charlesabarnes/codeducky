use std::sync::Arc;

use std::collections::HashMap;

use ducky_git::{Branch, CommitStats, Head, MAX_BRANCH_COMMITS, Repo};
use ducky_host::Host;
use ducky_notes::NotesRepo;
use ducky_review::{BranchCommit, Note, ReviewState, ReviewTarget, Timestamp};

use crate::changes::ChangedFile;
use crate::checklists::ChecklistStore;
use crate::connection::Connection;
use crate::error::{Result, SessionError};
use crate::file_diff::{DiffOptions, FileDiff, load_file_diff};
use crate::notes::NotesService;
use crate::since::{SinceLook, since_look};

/// What to open: a folder in a checkout, on this machine or a herdr-core machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewRequest {
    pub path: String,
    pub machine: Option<String>,
    /// A rev to compare against; `None` for the repository's default base.
    pub base: Option<String>,
}

impl ReviewRequest {
    pub fn local(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            machine: None,
            base: None,
        }
    }
}

/// A branch under review: its head, its base and what changed, read once. Refresh by opening
/// it again ([`Review::refresh`]).
#[derive(Clone)]
pub struct Review {
    pub request: ReviewRequest,
    pub repo: Repo,
    pub head: Head,
    pub target: ReviewTarget,
    /// The base as asked for or defaulted: `origin/main`.
    pub base: String,
    /// Where the branch left the base: the commit every diff is taken against.
    pub merge_base: String,
    pub default_base: Option<String>,
    pub branches: Vec<Branch>,
    pub files: Vec<ChangedFile>,
    pub commits: Vec<BranchCommit>,
    /// More commits than the picker lists; the oldest are left out.
    pub commits_truncated: bool,
    pub commit_stats: HashMap<String, CommitStats>,
    pub notes: Vec<Note>,
    pub state: ReviewState,
    /// The notes or state file could not be read; the review opens without them.
    pub notes_problem: Option<String>,
    /// What changed since your last look; `None` before any look.
    pub since: Option<SinceLook>,
    service: NotesService,
    notes_repo: NotesRepo,
}

impl std::fmt::Debug for Review {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Review")
            .field("request", &self.request)
            .field("target", &self.target)
            .field("base", &self.base)
            .field("files", &self.files.len())
            .finish_non_exhaustive()
    }
}

/// Where a detached checkout keeps its notes.
pub fn detached_target(sha: &str) -> ReviewTarget {
    ReviewTarget::branch(format!("detached/{}", &sha[..sha.len().min(12)]))
}

impl Review {
    /// A `~/…` path is resolved on the repo's machine first.
    pub fn open(connection: &Connection, mut request: ReviewRequest) -> Result<Self> {
        let host = connection.host(request.machine.as_deref())?;
        request.path = crate::browse::resolve_home(&*host, &request.path)?;
        Self::open_on(host, request)
    }

    pub fn open_on(host: Arc<dyn Host>, request: ReviewRequest) -> Result<Self> {
        let repo = Repo::open(host, &request.path)?;
        let head = repo.head()?;
        let sha = head
            .sha
            .clone()
            .ok_or_else(|| SessionError::NoHead(repo.info().toplevel.clone()))?;
        let target = match &head.branch {
            Some(branch) => ReviewTarget::branch(branch.clone()),
            None => detached_target(&sha),
        };
        let branches = repo.branches()?;
        let default_base = repo.default_base()?;
        let base = request
            .base
            .clone()
            .or_else(|| default_base.clone())
            .ok_or_else(|| {
                SessionError::NoBase("no origin/HEAD, main or master; pick a base".into())
            })?;
        let merge_base = repo
            .merge_base(&base, &sha)?
            .ok_or_else(|| SessionError::NoBase(format!("{base} shares no history with HEAD")))?;
        let files: Vec<ChangedFile> = repo
            .working_changes(&merge_base)?
            .into_iter()
            .map(ChangedFile::from_git)
            .collect();
        let listed = repo.commits(&merge_base, &sha, MAX_BRANCH_COMMITS)?;
        let commits_truncated = listed.truncated;
        let commit_stats = repo.commit_stats(&merge_base, &sha)?;
        let commits = listed
            .commits
            .into_iter()
            .map(|commit| BranchCommit {
                author: commit.author_name.clone(),
                date: Timestamp::from_millis(commit.author_time.saturating_mul(1000)),
                sha: commit.sha,
                parents: commit.parents,
                message: commit.message,
            })
            .collect();
        let notes_repo = NotesRepo::open(&**repo.host(), &repo.info().toplevel)?;
        let store = notes_repo.review(target.clone())?;
        let service = NotesService::new(
            repo.clone(),
            store,
            merge_base.clone(),
            Some(sha.clone()),
            notes_repo.readme_path(),
        );
        let mut review = Self {
            request,
            repo,
            head,
            target,
            base,
            merge_base,
            default_base,
            branches,
            files,
            commits,
            commits_truncated,
            commit_stats,
            notes: Vec::new(),
            state: ReviewState::default(),
            notes_problem: None,
            since: None,
            service,
            notes_repo,
        };
        if let Err(error) = review
            .service
            .reanchor(&review.files)
            .and_then(|_| review.reload_notes())
        {
            review.notes_problem = Some(error.to_string());
        }
        Ok(review)
    }

    /// Reads everything again with the same base, re-anchoring notes.
    pub fn refresh(&self) -> Result<Self> {
        Self::open_on(self.repo.host().clone(), self.request.clone())
    }

    /// The same checkout against another base.
    pub fn with_base(&self, base: impl Into<String>) -> Result<Self> {
        let request = ReviewRequest {
            base: Some(base.into()),
            ..self.request.clone()
        };
        Self::open_on(self.repo.host().clone(), request)
    }

    /// Reads the notes and state files again, e.g. after an agent edited them.
    pub fn reload_notes(&mut self) -> Result<()> {
        self.notes = self.service.notes()?;
        self.state = self.service.state()?;
        self.notes_problem = None;
        self.refresh_since()
    }

    /// Classifies the files against your last looks again, e.g. after marking one viewed.
    pub fn refresh_since(&mut self) -> Result<()> {
        self.since = since_look(
            &self.repo,
            &self.files,
            &self.state,
            self.head.sha.as_deref(),
        )?;
        Ok(())
    }

    /// Repo checklists beside the notes; global ones in `global_dir` on this machine.
    pub fn checklist_store(&self, global_dir: Option<String>) -> ChecklistStore {
        ChecklistStore::new(self.notes_repo.clone(), self.host().clone(), global_dir)
    }

    pub fn notes_service(&self) -> &NotesService {
        &self.service
    }

    /// The machine the checkout is on; `None` for this one.
    pub fn machine(&self) -> Option<&str> {
        self.request.machine.as_deref()
    }

    pub fn host(&self) -> &Arc<dyn Host> {
        self.repo.host()
    }

    pub fn toplevel(&self) -> &str {
        &self.repo.info().toplevel
    }

    pub fn branch_label(&self) -> String {
        match &self.target {
            ReviewTarget::Branch { branch } => branch.clone(),
            ReviewTarget::PullRequest { number } => format!("#{number}"),
        }
    }

    pub fn file_index(&self, path: &str) -> Option<usize> {
        self.files.iter().position(|file| file.path() == path)
    }

    pub fn load_diff(&self, path: &str, options: DiffOptions) -> Result<FileDiff> {
        let file = self
            .files
            .iter()
            .find(|file| file.path() == path)
            .ok_or_else(|| SessionError::UnknownFile(path.to_owned()))?;
        load_file_diff(&self.repo, &self.merge_base, file, options)
    }

    pub fn is_viewed(&self, file: &ChangedFile) -> bool {
        self.state.is_viewed(&file.change)
    }

    pub fn viewed_count(&self) -> usize {
        self.files
            .iter()
            .filter(|file| self.is_viewed(file))
            .count()
    }

    pub fn notes_on(&self, path: &str) -> impl Iterator<Item = &Note> {
        self.notes.iter().filter(move |note| note.path == path)
    }
}
