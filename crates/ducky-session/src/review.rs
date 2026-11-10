use std::collections::HashMap;
use std::sync::Arc;

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
use crate::pull::PullContext;
use crate::sides::Content;
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

/// A branch or pull request under review: its head, its base and what changed, read once.
/// Refresh by opening it again ([`Review::refresh`]).
#[derive(Clone)]
pub struct Review {
    pub request: ReviewRequest,
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
    /// Set when this reviews a pull request.
    pub pull: Option<PullContext>,
    pub(crate) content: Content,
    /// The checkout's top folder, or `github.com/<owner>/<name>` for a pull request read from
    /// GitHub.
    pub(crate) root: String,
    pub(crate) notes_host: Arc<dyn Host>,
    pub(crate) service: NotesService,
    pub(crate) notes_repo: NotesRepo,
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
        Self::open_checkout(host, request, None)
    }

    /// `target` overrides where the notes go (a pull request's checkout keeps them as the pull
    /// request's).
    pub(crate) fn open_checkout(
        host: Arc<dyn Host>,
        request: ReviewRequest,
        target: Option<ReviewTarget>,
    ) -> Result<Self> {
        let repo = Repo::open(host, &request.path)?;
        let head = repo.head()?;
        let sha = head
            .sha
            .clone()
            .ok_or_else(|| SessionError::NoHead(repo.info().toplevel.clone()))?;
        let target = target.unwrap_or_else(|| match &head.branch {
            Some(branch) => ReviewTarget::branch(branch.clone()),
            None => detached_target(&sha),
        });
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
        let content = Content::Git(repo.clone());
        let service = NotesService::new(
            content.clone(),
            repo.host().clone(),
            store,
            merge_base.clone(),
            Some(sha.clone()),
            notes_repo.readme_path(),
        );
        let review = Self {
            request,
            root: repo.info().toplevel.clone(),
            notes_host: repo.host().clone(),
            content,
            pull: None,
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
        Ok(review.with_notes())
    }

    /// Re-anchors and reads the notes; a problem is kept for the UI rather than failing.
    pub(crate) fn with_notes(mut self) -> Self {
        if let Err(error) = self
            .service
            .reanchor(&self.files)
            .and_then(|_| self.reload_notes())
        {
            self.notes_problem = Some(error.to_string());
        }
        self
    }

    /// Reads everything again with the same base, re-anchoring notes. A pull request is read
    /// again from GitHub, at its current head.
    pub fn refresh(&self) -> Result<Self> {
        match (&self.pull, self.content.repo()) {
            (Some(pull), _) => crate::pull::open_pull(&pull.client, pull.opened.clone()),
            (None, Some(repo)) => Self::open_on(repo.host().clone(), self.request.clone()),
            (None, None) => Err(SessionError::NeedsCheckout),
        }
    }

    /// The same checkout against another base.
    pub fn with_base(&self, base: impl Into<String>) -> Result<Self> {
        if self.pull.is_some() {
            return Err(SessionError::PullBase);
        }
        let repo = self.content.repo().ok_or(SessionError::NeedsCheckout)?;
        let request = ReviewRequest {
            base: Some(base.into()),
            ..self.request.clone()
        };
        Self::open_on(repo.host().clone(), request)
    }

    /// The checkout under review; `None` for a pull request read from GitHub.
    pub fn repo(&self) -> Option<&Repo> {
        self.content.repo()
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
            &self.content,
            &self.files,
            &self.state,
            self.head.sha.as_deref(),
        )?;
        Ok(())
    }

    /// Repo checklists beside the notes; global ones in `global_dir` on this machine.
    pub fn checklist_store(&self, global_dir: Option<String>) -> ChecklistStore {
        ChecklistStore::new(self.notes_repo.clone(), self.notes_host.clone(), global_dir)
    }

    pub fn notes_service(&self) -> &NotesService {
        &self.service
    }

    /// The machine the checkout is on; `None` for this one.
    pub fn machine(&self) -> Option<&str> {
        self.request.machine.as_deref()
    }

    /// The machine that holds the notes.
    pub fn host(&self) -> &Arc<dyn Host> {
        &self.notes_host
    }

    pub fn toplevel(&self) -> &str {
        &self.root
    }

    pub fn branch_label(&self) -> String {
        match (&self.target, &self.head.branch) {
            (ReviewTarget::Branch { branch }, _) => branch.clone(),
            (ReviewTarget::PullRequest { number }, Some(branch)) => format!("#{number} {branch}"),
            (ReviewTarget::PullRequest { number }, None) => format!("#{number}"),
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
        load_file_diff(&self.content, &self.merge_base, file, options)
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
