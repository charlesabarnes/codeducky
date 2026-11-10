use ducky_review::{BranchCommit, Timestamp};
use serde::Deserialize;

use crate::client::Client;
use crate::error::Result;
use crate::remote::RepoRef;
use crate::url::repo_path;

use super::files::{PullFile, RawFile};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub html_url: String,
    pub draft: bool,
    pub head_sha: String,
    pub head_ref: String,
    pub base_ref: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullState {
    Open,
    Closed,
    Merged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Label {
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullDetail {
    pub pr: PullRequest,
    pub body: String,
    pub state: PullState,
    pub author: String,
    /// The base branch tip when the PR was last updated (not the merge base).
    pub base_sha: String,
    /// `owner/name` of the head repository; `None` when the fork is gone.
    pub head_repo: Option<String>,
    /// The fork's owner lets maintainers of the base repository push to the head branch.
    pub maintainer_can_modify: bool,
    pub labels: Vec<Label>,
    pub requested_reviewers: Vec<String>,
    /// Team slugs.
    pub requested_teams: Vec<String>,
    pub additions: u32,
    pub deletions: u32,
    pub changed_files: u32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullReview {
    pub id: u64,
    pub node_id: Option<String>,
    pub author: String,
    /// APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED or PENDING.
    pub state: String,
    pub body: String,
    pub submitted_at: Option<String>,
    pub html_url: String,
    pub commit_id: Option<String>,
}

/// A comment in the pull request's conversation, not on a line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueComment {
    pub id: u64,
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
    pub html_url: String,
}

#[derive(Deserialize)]
pub(crate) struct RawUser {
    pub login: String,
}

pub(crate) fn login(user: Option<RawUser>) -> String {
    user.map_or_else(|| "ghost".to_owned(), |u| u.login)
}

#[derive(Deserialize)]
struct RawBranch {
    sha: String,
    #[serde(rename = "ref")]
    name: String,
    repo: Option<RawRepoName>,
}

#[derive(Deserialize)]
struct RawRepoName {
    full_name: String,
}

#[derive(Deserialize)]
struct RawPull {
    number: u64,
    title: String,
    html_url: String,
    #[serde(default)]
    draft: bool,
    head: RawBranch,
    base: RawBranch,
}

impl RawPull {
    fn summary(&self) -> PullRequest {
        PullRequest {
            number: self.number,
            title: self.title.clone(),
            html_url: self.html_url.clone(),
            draft: self.draft,
            head_sha: self.head.sha.clone(),
            head_ref: self.head.name.clone(),
            base_ref: self.base.name.clone(),
        }
    }
}

#[derive(Deserialize)]
struct RawLabel {
    name: String,
    color: Option<String>,
}

#[derive(Deserialize)]
struct RawTeam {
    slug: String,
}

#[derive(Deserialize)]
struct RawPullDetail {
    #[serde(flatten)]
    pull: RawPull,
    body: Option<String>,
    state: String,
    #[serde(default)]
    merged: bool,
    user: Option<RawUser>,
    #[serde(default)]
    maintainer_can_modify: bool,
    #[serde(default)]
    labels: Vec<RawLabel>,
    #[serde(default)]
    requested_reviewers: Vec<RawUser>,
    #[serde(default)]
    requested_teams: Vec<RawTeam>,
    #[serde(default)]
    additions: u32,
    #[serde(default)]
    deletions: u32,
    #[serde(default)]
    changed_files: u32,
    created_at: String,
    updated_at: String,
}

impl From<RawPullDetail> for PullDetail {
    fn from(raw: RawPullDetail) -> Self {
        let state = match (raw.merged, raw.state.as_str()) {
            (true, _) => PullState::Merged,
            (false, "closed") => PullState::Closed,
            _ => PullState::Open,
        };
        Self {
            pr: raw.pull.summary(),
            body: raw.body.unwrap_or_default(),
            state,
            author: login(raw.user),
            base_sha: raw.pull.base.sha,
            head_repo: raw.pull.head.repo.map(|r| r.full_name),
            maintainer_can_modify: raw.maintainer_can_modify,
            labels: raw
                .labels
                .into_iter()
                .map(|l| Label {
                    name: l.name,
                    color: l.color,
                })
                .collect(),
            requested_reviewers: raw
                .requested_reviewers
                .into_iter()
                .map(|u| u.login)
                .collect(),
            requested_teams: raw.requested_teams.into_iter().map(|t| t.slug).collect(),
            additions: raw.additions,
            deletions: raw.deletions,
            changed_files: raw.changed_files,
            created_at: raw.created_at,
            updated_at: raw.updated_at,
        }
    }
}

#[derive(Deserialize)]
struct RawReview {
    id: u64,
    node_id: Option<String>,
    user: Option<RawUser>,
    state: String,
    body: Option<String>,
    submitted_at: Option<String>,
    html_url: String,
    commit_id: Option<String>,
}

#[derive(Deserialize)]
struct RawIssueComment {
    id: u64,
    user: Option<RawUser>,
    body: Option<String>,
    created_at: String,
    updated_at: String,
    html_url: String,
}

#[derive(Deserialize)]
struct RawCommit {
    sha: String,
    parents: Vec<RawParent>,
    commit: RawCommitInner,
    author: Option<RawUser>,
}

#[derive(Deserialize)]
struct RawParent {
    sha: String,
}

#[derive(Deserialize)]
struct RawCommitInner {
    message: String,
    author: Option<RawGitAuthor>,
}

#[derive(Deserialize)]
struct RawGitAuthor {
    name: Option<String>,
    date: Option<String>,
}

fn to_branch_commit(raw: RawCommit) -> BranchCommit {
    let git_author = raw.commit.author;
    BranchCommit {
        sha: raw.sha,
        parents: raw.parents.into_iter().map(|p| p.sha).collect(),
        message: raw.commit.message.trim_end().to_owned(),
        author: git_author
            .as_ref()
            .and_then(|a| a.name.clone())
            .or_else(|| raw.author.map(|u| u.login))
            .unwrap_or_else(|| "unknown".to_owned()),
        date: git_author
            .and_then(|a| a.date)
            .and_then(|d| d.parse::<Timestamp>().ok())
            .unwrap_or_default(),
    }
}

impl Client {
    pub fn pull(&self, repo: &RepoRef, number: u64) -> Result<PullDetail> {
        let raw: RawPullDetail =
            self.get_json(&format!("{}/pulls/{number}", repo_path(repo)), &[])?;
        Ok(raw.into())
    }

    /// The open pull request from `branch` in `head_owner`'s repository or fork (`None`: the
    /// repository's own owner).
    pub fn open_pull_for_branch(
        &self,
        repo: &RepoRef,
        branch: &str,
        head_owner: Option<&str>,
    ) -> Result<Option<PullRequest>> {
        let owner = head_owner.unwrap_or(&repo.owner);
        let pulls: Vec<RawPull> = self.get_json(
            &format!("{}/pulls", repo_path(repo)),
            &[
                ("head", format!("{owner}:{branch}")),
                ("state", "open".into()),
                ("per_page", "10".into()),
            ],
        )?;
        Ok(pulls.first().map(RawPull::summary))
    }

    pub fn pull_files(&self, repo: &RepoRef, number: u64) -> Result<Vec<PullFile>> {
        let path = format!("{}/pulls/{number}/files", repo_path(repo));
        self.paginate(&path, &[], |page: Vec<RawFile>| {
            page.into_iter().map(PullFile::from).collect()
        })
    }

    /// Oldest first; GitHub lists at most 250.
    pub fn pull_commits(&self, repo: &RepoRef, number: u64) -> Result<Vec<BranchCommit>> {
        let path = format!("{}/pulls/{number}/commits", repo_path(repo));
        self.paginate(&path, &[], |page: Vec<RawCommit>| {
            page.into_iter().map(to_branch_commit).collect()
        })
    }

    /// Submitted reviews, oldest first; other people's pending reviews are never listed.
    pub fn pull_reviews(&self, repo: &RepoRef, number: u64) -> Result<Vec<PullReview>> {
        let path = format!("{}/pulls/{number}/reviews", repo_path(repo));
        self.paginate(&path, &[], |page: Vec<RawReview>| {
            page.into_iter()
                .map(|r| PullReview {
                    id: r.id,
                    node_id: r.node_id,
                    author: login(r.user),
                    state: r.state,
                    body: r.body.unwrap_or_default(),
                    submitted_at: r.submitted_at,
                    html_url: r.html_url,
                    commit_id: r.commit_id,
                })
                .collect()
        })
    }

    pub fn issue_comments(&self, repo: &RepoRef, number: u64) -> Result<Vec<IssueComment>> {
        let path = format!("{}/issues/{number}/comments", repo_path(repo));
        self.paginate(&path, &[], |page: Vec<RawIssueComment>| {
            page.into_iter()
                .map(|c| IssueComment {
                    id: c.id,
                    author: login(c.user),
                    body: c.body.unwrap_or_default(),
                    created_at: c.created_at,
                    updated_at: c.updated_at,
                    html_url: c.html_url,
                })
                .collect()
        })
    }
}
