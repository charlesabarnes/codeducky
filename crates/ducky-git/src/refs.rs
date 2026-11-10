use crate::repo::Repo;
use crate::runner::{Result, line, text};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    /// The checked-out branch; `None` when detached.
    pub branch: Option<String>,
    /// `None` on a branch with no commits yet.
    pub sha: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Branch {
    /// What to pass as a rev: `main`, `origin/main`.
    pub name: String,
    /// `refs/heads/main`, `refs/remotes/origin/main`.
    pub refname: String,
    pub sha: String,
    /// The remote, for a remote-tracking branch.
    pub remote: Option<String>,
    /// A local branch's upstream, short (`origin/main`).
    pub upstream: Option<String>,
    pub is_head: bool,
}

/// How HEAD moved since a reviewed head, along first parents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HeadMove {
    /// Commits on top of the old head; `None` when it is not on HEAD's first-parent path.
    pub commits: Option<usize>,
    pub rewritten: bool,
}

const PREFERRED_BASES: &[&str] = &["origin/main", "origin/master", "main", "master"];
const HEAD_MOVE_LIMIT: usize = 1000;

impl Repo {
    pub fn head(&self) -> Result<Head> {
        let branch = self
            .git
            .run_maybe(&["symbolic-ref", "-q", "--short", "HEAD"])?
            .map(|out| line(&out));
        Ok(Head {
            branch,
            sha: self.resolve("HEAD")?,
        })
    }

    /// The commit `rev` names, or `None` when it names none.
    pub fn resolve(&self, rev: &str) -> Result<Option<String>> {
        let spec = format!("{rev}^{{commit}}");
        let output = self.git.output(
            &["rev-parse", "-q", "--verify", "--end-of-options", &spec],
            None,
        )?;
        Ok((output.status == Some(0)).then(|| line(&output.stdout)))
    }

    /// Local branches, then remote-tracking ones, each sorted by name. Symbolic refs such as
    /// `origin/HEAD` are left out.
    pub fn branches(&self) -> Result<Vec<Branch>> {
        let out = self.git.run(&[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(symref)%00%(HEAD)",
            "refs/heads",
            "refs/remotes",
        ])?;
        Ok(parse_branches(&text(&out)))
    }

    /// `origin/HEAD`'s target, else the first of origin/main, origin/master, main, master.
    pub fn default_base(&self) -> Result<Option<String>> {
        let branches = self.branches()?;
        let has = |name: &str| branches.iter().any(|b| b.name == name);
        let origin_head = self
            .git
            .run_maybe(&["symbolic-ref", "-q", "refs/remotes/origin/HEAD"])?
            .map(|out| line(&out));
        if let Some(target) = origin_head
            .as_deref()
            .and_then(|r| r.strip_prefix("refs/remotes/"))
            .filter(|name| has(name))
        {
            return Ok(Some(target.to_owned()));
        }
        Ok(PREFERRED_BASES
            .iter()
            .find(|name| has(name))
            .map(|name| (*name).to_owned()))
    }

    /// `None` when the two have no common ancestor.
    pub fn merge_base(&self, a: &str, b: &str) -> Result<Option<String>> {
        Ok(self
            .git
            .run_maybe(&["merge-base", "--end-of-options", a, b])?
            .map(|out| line(&out)))
    }

    pub fn is_ancestor(&self, ancestor: &str, of: &str) -> Result<bool> {
        Ok(self
            .git
            .run_maybe(&[
                "merge-base",
                "--is-ancestor",
                "--end-of-options",
                ancestor,
                of,
            ])?
            .is_some())
    }

    pub fn remote_url(&self, remote: &str) -> Result<Option<String>> {
        let key = format!("remote.{remote}.url");
        Ok(self
            .git
            .run_maybe(&["config", "--get", &key])?
            .map(|out| line(&out)))
    }

    /// `rev` and its first parents, newest first, at most `limit`.
    pub fn first_parents(&self, rev: &str, limit: usize) -> Result<Vec<String>> {
        let max = format!("--max-count={limit}");
        let out = self.git.run(&[
            "rev-list",
            "--first-parent",
            &max,
            "--end-of-options",
            rev,
            "--",
        ])?;
        Ok(text(&out).lines().map(str::to_owned).collect())
    }

    pub fn head_move_since(&self, from: &str) -> Result<HeadMove> {
        if self.resolve("HEAD")?.is_none() {
            return Ok(HeadMove {
                commits: None,
                rewritten: true,
            });
        }
        let chain = self.first_parents("HEAD", HEAD_MOVE_LIMIT + 1)?;
        Ok(match chain.iter().position(|sha| sha == from) {
            Some(commits) => HeadMove {
                commits: Some(commits),
                rewritten: false,
            },
            None => HeadMove {
                commits: None,
                rewritten: true,
            },
        })
    }
}

fn parse_branches(out: &str) -> Vec<Branch> {
    let mut local = Vec::new();
    let mut remote = Vec::new();
    for record in out.lines() {
        let fields: Vec<&str> = record.split('\0').collect();
        let [refname, sha, upstream, symref, head] = fields[..] else {
            continue;
        };
        if !symref.is_empty() {
            continue;
        }
        let upstream = Some(upstream.to_owned()).filter(|u| !u.is_empty());
        if let Some(name) = refname.strip_prefix("refs/heads/") {
            local.push(Branch {
                name: name.into(),
                refname: refname.into(),
                sha: sha.into(),
                remote: None,
                upstream,
                is_head: head == "*",
            });
        } else if let Some(name) = refname.strip_prefix("refs/remotes/") {
            remote.push(Branch {
                name: name.into(),
                refname: refname.into(),
                sha: sha.into(),
                remote: name.split_once('/').map(|(r, _)| r.to_owned()),
                upstream: None,
                is_head: false,
            });
        }
    }
    local.sort_by(|a, b| a.name.cmp(&b.name));
    remote.sort_by(|a, b| a.name.cmp(&b.name));
    local.extend(remote);
    local
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branches_and_skips_symbolic_refs() {
        let out = "refs/heads/feat/x\0aaa\0origin/feat/x\0\0*\n\
refs/heads/main\0bbb\0\0\0 \n\
refs/remotes/origin/HEAD\0bbb\0\0refs/remotes/origin/main\0 \n\
refs/remotes/origin/main\0bbb\0\0\0 \n";
        let branches = parse_branches(out);
        let names: Vec<&str> = branches.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, ["feat/x", "main", "origin/main"]);
        assert!(branches[0].is_head);
        assert_eq!(branches[0].upstream.as_deref(), Some("origin/feat/x"));
        assert_eq!(branches[2].remote.as_deref(), Some("origin"));
        assert_eq!(branches[1].upstream, None);
    }
}
