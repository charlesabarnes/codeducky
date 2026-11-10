//! The `git` CLI over a [`ducky_host::Host`], so the same calls work on any machine, and a
//! unified-diff parser.
//!
//! Output shapes are pinned (`-z`, `--raw`, `--numstat`, fixed prefixes, `core.quotepath=off`,
//! `LC_ALL=C`, `GIT_OPTIONAL_LOCKS=0`, literal pathspecs), so the user's git config only matters
//! where it changes content (attributes, filters), never where it changes format.
//!
//! Output over the host's cap (8 MiB through herdr-core) is [`GitError::TooLarge`] for lists
//! and blobs; patches are fetched in batches and a file that alone is too large comes back
//! `too_large` (see [`Repo::patches`]).

mod changes;
mod commits;
mod content;
mod diff;
mod model;
pub mod patch;
mod raw;
mod refs;
mod repo;
mod runner;

pub use changes::DiffSpec;
pub use commits::{Commit, CommitList, MAX_BRANCH_COMMITS};
pub use content::{BlobInfo, DEFAULT_MAX_BYTES, FileSide, is_binary};
pub use diff::FilePatch;
pub use model::{ChangeStatus, FileChange, FileKind, LineStats, Mode};
pub use patch::{DiffLine, FileDiff, Hunk, LineKind, parse_patch};
pub use refs::{Branch, Head, HeadMove};
pub use repo::{Repo, RepoInfo, Worktree};
pub use runner::{DEFAULT_TIMEOUT, GitError, Result};
