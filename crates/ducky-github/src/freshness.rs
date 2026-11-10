//! Is the local view of a branch current with GitHub, and which base does GitHub diff against.
//! Git work (first parents, the local merge base) stays with the caller; this takes its results.

use std::thread;

use crate::client::Client;
use crate::error::{ErrorKind, GitHubError, Result};
use crate::remote::RepoRef;

/// How far back HEAD's first-parent chain is checked for a commit GitHub knows.
pub const ANCESTOR_LIMIT: usize = 50;
const BATCH: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Freshness {
    /// The local `origin/<base>` matches GitHub.
    Fresh {
        remote_tip: String,
    },
    NoRemoteBranch,
    /// The local `origin/<base>` differs from GitHub; `head_pushed` says whether GitHub has the
    /// local HEAD commit.
    Stale {
        local_tip: String,
        remote_tip: String,
        head_pushed: bool,
    },
}

pub fn check_freshness(
    client: &Client,
    repo: &RepoRef,
    base_branch: &str,
    local_tip: &str,
    head_sha: &str,
) -> Result<Freshness> {
    let Some(remote_tip) = client.branch_head(repo, base_branch)? else {
        return Ok(Freshness::NoRemoteBranch);
    };
    if remote_tip == local_tip {
        return Ok(Freshness::Fresh { remote_tip });
    }
    Ok(Freshness::Stale {
        local_tip: local_tip.to_owned(),
        head_pushed: client.commit_exists(repo, head_sha)?,
        remote_tip,
    })
}

/// The merge base of GitHub's base tip and a commit that must already be on GitHub.
pub fn github_merge_base(
    client: &Client,
    repo: &RepoRef,
    remote_tip: &str,
    head_sha: &str,
) -> Result<String> {
    Ok(client.compare(repo, remote_tip, head_sha)?.merge_base_sha)
}

/// The first commit of `chain` (HEAD's first parents, newest first, at most
/// [`ANCESTOR_LIMIT`]) that GitHub has. HEAD is checked alone first since it is usually pushed,
/// then the rest ten at a time in parallel.
pub fn pushed_ancestor(
    client: &Client,
    repo: &RepoRef,
    chain: &[String],
) -> Result<Option<String>> {
    let chain = &chain[..chain.len().min(ANCESTOR_LIMIT)];
    let Some((head, rest)) = chain.split_first() else {
        return Ok(None);
    };
    if client.commit_exists(repo, head)? {
        return Ok(Some(head.clone()));
    }
    for batch in rest.chunks(BATCH) {
        let known: Vec<Result<bool>> = thread::scope(|scope| {
            let handles: Vec<_> = batch
                .iter()
                .map(|sha| scope.spawn(move || client.commit_exists(repo, sha)))
                .collect();
            handles
                .into_iter()
                .map(|h| {
                    h.join()
                        .unwrap_or_else(|_| Err(GitHubError::network("a lookup thread panicked")))
                })
                .collect()
        });
        for (sha, found) in batch.iter().zip(known) {
            if found? {
                return Ok(Some(sha.clone()));
            }
        }
    }
    Ok(None)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitHubBase {
    pub head_sha: String,
    pub base_sha: String,
    pub branch: String,
    pub tip_sha: String,
    /// Set when the base was found through an older pushed commit rather than HEAD.
    pub pushed_sha: Option<String>,
    /// The local merge base was used: no commit in the chain is on GitHub.
    pub fallback: bool,
}

/// The merge base of GitHub's `base_branch` tip and HEAD, through HEAD's nearest pushed
/// ancestor. `local_merge_base` is used when none of `chain` is on GitHub; it is on GitHub
/// whenever it was fetched from there.
pub fn find_github_base(
    client: &Client,
    repo: &RepoRef,
    chain: &[String],
    base_branch: &str,
    remote_tip: Option<&str>,
    local_merge_base: impl FnOnce() -> Result<String>,
) -> Result<GitHubBase> {
    let head_sha = chain
        .first()
        .cloned()
        .ok_or_else(|| GitHubError::new(ErrorKind::Invalid, 0, "HEAD has no commits."))?;
    let tip_sha = match remote_tip {
        Some(tip) => tip.to_owned(),
        None => client.branch_head(repo, base_branch)?.ok_or_else(|| {
            GitHubError::new(
                ErrorKind::NotFound,
                404,
                format!("GitHub has no branch named {base_branch}."),
            )
        })?,
    };
    let (ancestor, fallback) = match pushed_ancestor(client, repo, chain)? {
        Some(sha) => (sha, false),
        None => (local_merge_base()?, true),
    };
    let base_sha = github_merge_base(client, repo, &tip_sha, &ancestor)?;
    Ok(GitHubBase {
        pushed_sha: (ancestor != head_sha).then_some(ancestor),
        head_sha,
        base_sha,
        branch: base_branch.to_owned(),
        tip_sha,
        fallback,
    })
}
