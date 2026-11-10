//! GitHub: inbox, pull request diffs, review threads, pushing notes as reviews, and CI.
//!
//! Blocking by design (no async runtime): every call that talks to GitHub runs on the calling
//! thread, so call it from a background executor. github.com only.

pub mod api;
mod blob_cache;
pub mod ci;
mod client;
mod error;
#[cfg(feature = "test-support")]
pub mod fake;
pub mod freshness;
pub mod inbox;
pub mod placement;
pub mod pr_diff;
mod remote;
pub mod review;
pub mod reviewers;
pub mod threads;
mod token;
mod url;

pub use api::checks::{
    AnnotationLevel, CheckAnnotation, CheckConclusion, CheckRun, CheckStatus, CommitStatus,
    StatusState,
};
pub use api::files::{FileStatus, PullFile};
pub use api::pulls::{IssueComment, Label, PullDetail, PullRequest, PullReview, PullState};
pub use api::repos::{CompareStatus, Comparison, RepoSummary, Tree, TreeEntry, Viewer};
pub use api::reviews::{
    Review, ReviewComment, ReviewCommentInput, ReviewEvent, ReviewInput, github_side,
};
pub use blob_cache::BlobCache;
pub use client::{Client, GITHUB_API};
pub use ducky_review::Side;
pub use error::{ErrorKind, GitHubError, Result};
pub use remote::{PullRef, RepoRef, match_pull_path, parse_github_remote, parse_pull_reference};
pub use token::{Token, TokenProvider, TokenSource};
