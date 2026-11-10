//! Pull request reviews: opened through the GitHub API alone, or on a checkout at the pull
//! request's head; their threads, CI and reviewers; pushing notes and submitting a review.

mod carry;
mod files;
mod live;
mod open;
mod push;

pub use carry::carry_branch_notes;
pub(crate) use files::changes_between;
pub use live::{
    PullActivity, current_head, file_annotations, file_threads, load_activity, load_ci,
    reply_to_thread, set_thread_resolved,
};
pub use open::{CheckoutRequest, PullOpen, branch_pull, github_repo, open_pull};
pub use push::{push_notes, push_preview, submit_review};

use ducky_github::pr_diff::PrSnapshot;
use ducky_github::{Client, PullRequest, RepoRef};

/// What a pull request review knows about the pull request, besides its files and notes.
#[derive(Clone)]
pub struct PullContext {
    pub repo: RepoRef,
    pub snapshot: PrSnapshot,
    pub client: Client,
    pub checkout: Checkout,
    /// How it was opened, to open it again on refresh.
    pub(crate) opened: PullOpen,
}

impl std::fmt::Debug for PullContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PullContext")
            .field("repo", &self.repo)
            .field("number", &self.number())
            .field("checkout", &self.checkout)
            .finish_non_exhaustive()
    }
}

impl PullContext {
    pub fn number(&self) -> u64 {
        self.snapshot.pull.pr.number
    }

    pub fn pr(&self) -> &PullRequest {
        &self.snapshot.pull.pr
    }

    pub fn head_sha(&self) -> &str {
        &self.snapshot.pull.pr.head_sha
    }

    pub fn label(&self) -> String {
        format!("{}#{}", self.repo, self.number())
    }
}

/// Where a pull request review's files come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Checkout {
    /// Read from GitHub; notes in the app's data folder.
    None,
    /// A checkout at the pull request's head: diffs come from it, and the editor and agents work.
    AtHead { path: String },
    /// A checkout of the repository at another commit: notes live in it, files come from GitHub.
    Elsewhere { path: String, head: Option<String> },
}

impl Checkout {
    /// Why the editor and agents are off, if they are.
    pub fn local_off_reason(&self) -> Option<String> {
        match self {
            Self::AtHead { .. } => None,
            Self::None => Some(
                "read from GitHub without a checkout: open the pull request from a checkout at its \
                 head for the editor and agents"
                    .into(),
            ),
            Self::Elsewhere { path, head } => Some(format!(
                "the checkout at {path} is at {}, not the pull request's head: check out the head \
                 for the editor and agents",
                head.as_deref().map_or("no commit", |h| &h[..h.len().min(7)])
            )),
        }
    }
}
