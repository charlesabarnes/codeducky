use base64::Engine;
use serde::Deserialize;

use crate::client::{Client, or_none};
use crate::error::{GitHubError, Result};
use crate::remote::RepoRef;
use crate::url::{encode, encode_path, repo_path};

use super::files::{PullFile, RawFile};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Viewer {
    pub login: String,
    pub name: Option<String>,
    /// The raw `github-authentication-token-expiration` header, when GitHub sends one.
    pub token_expires_at: Option<String>,
    /// Classic tokens list their scopes; fine-grained tokens and `gh` OAuth tokens may not.
    pub scopes: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RepoSummary {
    pub full_name: String,
    pub default_branch: String,
    pub private: bool,
    pub html_url: String,
    /// Whether the token's user can push; `None` when GitHub does not say.
    #[serde(skip)]
    pub can_push: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CompareStatus {
    Diverged,
    Ahead,
    Behind,
    Identical,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Comparison {
    pub status: CompareStatus,
    pub ahead_by: u32,
    pub behind_by: u32,
    pub merge_base_sha: String,
    pub files: Vec<PullFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TreeEntry {
    pub path: String,
    /// `blob`, `tree` or `commit` (a submodule).
    #[serde(rename = "type")]
    pub kind: String,
    pub sha: String,
    pub mode: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Tree {
    pub sha: String,
    pub truncated: bool,
    #[serde(rename = "tree")]
    pub entries: Vec<TreeEntry>,
}

#[derive(Deserialize)]
struct RawUser {
    login: String,
    name: Option<String>,
}

#[derive(Deserialize)]
struct RawRepo {
    #[serde(flatten)]
    summary: RepoSummary,
    permissions: Option<RawPermissions>,
}

#[derive(Deserialize)]
struct RawPermissions {
    push: Option<bool>,
}

#[derive(Deserialize)]
struct RawRef {
    object: RawSha,
}

#[derive(Deserialize)]
struct RawSha {
    sha: String,
}

#[derive(Deserialize)]
struct RawComparison {
    status: CompareStatus,
    ahead_by: u32,
    behind_by: u32,
    merge_base_commit: RawSha,
    #[serde(default)]
    files: Vec<RawFile>,
}

#[derive(Deserialize)]
struct RawBlob {
    content: String,
    encoding: String,
}

pub(crate) fn decode_base64(content: &str) -> Result<Vec<u8>> {
    let compact: String = content.chars().filter(|c| !c.is_whitespace()).collect();
    base64::engine::general_purpose::STANDARD
        .decode(compact)
        .map_err(|e| GitHubError::decode("blob", e))
}

impl Client {
    /// Who the token belongs to; also a cheap token check.
    pub fn viewer(&self) -> Result<Viewer> {
        let response = self.get("/user", &[])?;
        let user: RawUser = response.json("user")?;
        Ok(Viewer {
            login: user.login,
            name: user.name,
            token_expires_at: response
                .header("github-authentication-token-expiration")
                .map(str::to_owned),
            scopes: response.header("x-oauth-scopes").map(|scopes| {
                scopes
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect()
            }),
        })
    }

    pub fn repo(&self, repo: &RepoRef) -> Result<RepoSummary> {
        let raw: RawRepo = self.get_json(&repo_path(repo), &[])?;
        Ok(RepoSummary {
            can_push: raw.permissions.and_then(|p| p.push),
            ..raw.summary
        })
    }

    /// The commit a branch points at on GitHub; `None` when there is no such branch.
    pub fn branch_head(&self, repo: &RepoRef, branch: &str) -> Result<Option<String>> {
        let path = format!("{}/git/ref/heads/{}", repo_path(repo), encode_path(branch));
        Ok(or_none(self.get_json::<RawRef>(&path, &[]), &[404])?.map(|r| r.object.sha))
    }

    /// Whether GitHub has the commit (it was pushed).
    pub fn commit_exists(&self, repo: &RepoRef, sha: &str) -> Result<bool> {
        let path = format!("{}/commits/{}", repo_path(repo), encode(sha));
        Ok(or_none(self.get_json::<RawSha>(&path, &[]), &[404, 422])?.is_some())
    }

    /// Three-dot: the files changed from the merge base of `base` and `head` to `head`.
    pub fn compare(&self, repo: &RepoRef, base: &str, head: &str) -> Result<Comparison> {
        let path = format!(
            "{}/compare/{}...{}",
            repo_path(repo),
            encode(base),
            encode(head)
        );
        let raw: RawComparison = self.get_json(&path, &[])?;
        Ok(Comparison {
            status: raw.status,
            ahead_by: raw.ahead_by,
            behind_by: raw.behind_by,
            merge_base_sha: raw.merge_base_commit.sha,
            files: raw.files.into_iter().map(PullFile::from).collect(),
        })
    }

    pub fn tree(&self, repo: &RepoRef, sha: &str) -> Result<Tree> {
        let path = format!("{}/git/trees/{}", repo_path(repo), encode(sha));
        self.get_json(&path, &[("recursive", "1".into())])
    }

    pub fn blob(&self, repo: &RepoRef, sha: &str) -> Result<Vec<u8>> {
        let path = format!("{}/git/blobs/{}", repo_path(repo), encode(sha));
        let raw: RawBlob = self.get_json(&path, &[])?;
        if raw.encoding == "base64" {
            decode_base64(&raw.content)
        } else {
            Ok(raw.content.into_bytes())
        }
    }
}
