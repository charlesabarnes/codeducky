use std::sync::{Arc, OnceLock};
use std::time::Duration;

use ducky_host::Host;

use crate::runner::{GitError, Result, Runner, line, parse_error, text};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoInfo {
    /// The worktree's top folder, absolute on its machine.
    pub toplevel: String,
    pub git_dir: String,
    /// Shared by every worktree of the repository.
    pub common_dir: String,
}

impl RepoInfo {
    /// A worktree added with `git worktree add`, not the main checkout.
    pub fn is_linked_worktree(&self) -> bool {
        self.git_dir != self.common_dir
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worktree {
    pub path: String,
    /// `None` while the branch has no commits yet.
    pub head: Option<String>,
    /// `refs/heads/...` stripped; `None` when detached.
    pub branch: Option<String>,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
}

/// One worktree on one host. Every call runs `git` there; clone freely.
#[derive(Clone)]
pub struct Repo {
    pub(crate) git: Runner,
    info: RepoInfo,
    empty_tree: Arc<OnceLock<String>>,
}

impl std::fmt::Debug for Repo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Repo")
            .field("host", &self.git.host.name())
            .field("info", &self.info)
            .finish()
    }
}

impl Repo {
    /// Finds the repository that holds `path` (any folder inside a worktree).
    pub fn open(host: Arc<dyn Host>, path: &str) -> Result<Self> {
        let probe = Runner::new(host.clone(), path);
        let args = [
            "rev-parse",
            "--path-format=absolute",
            "--is-bare-repository",
            "--git-dir",
            "--git-common-dir",
        ];
        let output = probe.output(&args, None)?;
        if output.status != Some(0) {
            return Err(GitError::NotARepository { path: path.into() });
        }
        let out = text(&output.stdout);
        let lines: Vec<&str> = out.lines().collect();
        let [bare, git_dir, common_dir] = lines[..] else {
            return Err(parse_error(&args, out.clone()));
        };
        if bare == "true" {
            return Err(GitError::Bare { path: path.into() });
        }
        let toplevel =
            line(&probe.run(&["rev-parse", "--path-format=absolute", "--show-toplevel"])?);
        if toplevel.is_empty() {
            return Err(GitError::Bare { path: path.into() });
        }
        Ok(Self {
            git: Runner::new(host, toplevel.clone()),
            info: RepoInfo {
                toplevel,
                git_dir: git_dir.into(),
                common_dir: common_dir.into(),
            },
            empty_tree: Arc::default(),
        })
    }

    pub fn info(&self) -> &RepoInfo {
        &self.info
    }

    pub fn host(&self) -> &Arc<dyn Host> {
        &self.git.host
    }

    /// Per-command limit (default 120 s; herdr-core allows at most 600 s).
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.git.timeout = timeout;
        self
    }

    /// The empty tree's id in this repository's hash (sha1 or sha256).
    pub fn empty_tree(&self) -> Result<String> {
        if let Some(id) = self.empty_tree.get() {
            return Ok(id.clone());
        }
        let id = line(
            &self
                .git
                .run_with(&["hash-object", "-t", "tree", "--stdin"], Some(Vec::new()))?,
        );
        Ok(self.empty_tree.get_or_init(|| id).clone())
    }

    pub fn worktrees(&self) -> Result<Vec<Worktree>> {
        let out = self.git.run(&["worktree", "list", "--porcelain", "-z"])?;
        Ok(parse_worktrees(&out))
    }
}

fn parse_worktrees(out: &[u8]) -> Vec<Worktree> {
    let mut worktrees = Vec::new();
    let mut current: Option<Worktree> = None;
    for field in out.split(|b| *b == 0) {
        let field = text(field);
        if field.is_empty() {
            worktrees.extend(current.take());
            continue;
        }
        let (key, value) = field.split_once(' ').unwrap_or((&field, ""));
        if key == "worktree" {
            worktrees.extend(current.take());
            current = Some(Worktree {
                path: value.into(),
                head: None,
                branch: None,
                bare: false,
                locked: false,
                prunable: false,
            });
            continue;
        }
        let Some(worktree) = current.as_mut() else {
            continue;
        };
        match key {
            "HEAD" => worktree.head = Some(value.to_owned()).filter(|h| !is_null_oid(h)),
            "branch" => {
                worktree.branch = Some(value.strip_prefix("refs/heads/").unwrap_or(value).into())
            }
            "bare" => worktree.bare = true,
            "locked" => worktree.locked = true,
            "prunable" => worktree.prunable = true,
            _ => {}
        }
    }
    worktrees.extend(current);
    worktrees
}

pub(crate) fn is_null_oid(oid: &str) -> bool {
    !oid.is_empty() && oid.bytes().all(|b| b == b'0')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_worktree_porcelain() {
        let out = b"worktree /r/main\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/main\0\0\
worktree /r/my tree\0HEAD 2222222222222222222222222222222222222222\0detached\0locked\0\0";
        let worktrees = parse_worktrees(out);
        assert_eq!(worktrees.len(), 2);
        assert_eq!(worktrees[0].branch.as_deref(), Some("main"));
        assert_eq!(worktrees[1].path, "/r/my tree");
        assert_eq!(worktrees[1].branch, None);
        assert!(worktrees[1].locked);
    }
}
