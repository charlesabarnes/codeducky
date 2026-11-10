use std::collections::{HashMap, HashSet};

use crate::repo::Repo;
use crate::runner::{Result, parse_error, text};

/// What one commit changed against its first parent, as `git log --shortstat` counts it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CommitStats {
    pub files: u32,
    pub additions: u32,
    pub deletions: u32,
}

impl Repo {
    /// Which of `oids` name an object in the repository.
    pub fn existing_objects(&self, oids: &[&str]) -> Result<HashSet<String>> {
        let wanted: Vec<&str> = oids
            .iter()
            .copied()
            .filter(|oid| !oid.is_empty() && !oid.contains(char::is_whitespace))
            .collect();
        if wanted.is_empty() {
            return Ok(HashSet::new());
        }
        let input: String = wanted.iter().map(|oid| format!("{oid}\n")).collect();
        let out = text(&self.git.run_with(
            &["cat-file", "--batch-check=%(objectname) %(objecttype)"],
            Some(input.into_bytes()),
        )?);
        Ok(out
            .lines()
            .filter_map(
                |line| match line.split_whitespace().collect::<Vec<_>>()[..] {
                    [oid, kind] if kind != "missing" => Some(oid.to_owned()),
                    _ => None,
                },
            )
            .collect())
    }

    /// Writes the working-tree content of `paths` into the object database, so a later diff
    /// can read exactly what was there now. Returns each path's blob id, in order.
    pub fn store_worktree_blobs(&self, paths: &[&str]) -> Result<Vec<String>> {
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        if paths.iter().any(|path| path.contains('\n')) {
            return Err(parse_error(&["hash-object"], "a path with a newline"));
        }
        let input: String = paths.iter().map(|path| format!("{path}\n")).collect();
        let args = ["hash-object", "-w", "--stdin-paths"];
        let out = text(&self.git.run_with(&args, Some(input.into_bytes()))?);
        let oids: Vec<String> = out.lines().map(str::to_owned).collect();
        if oids.len() != paths.len() {
            return Err(parse_error(
                &args,
                format!("{} ids for {} paths", oids.len(), paths.len()),
            ));
        }
        Ok(oids)
    }

    /// Per-commit file and line counts for `head`'s first parents not reachable from `base`.
    pub fn commit_stats(&self, base: &str, head: &str) -> Result<HashMap<String, CommitStats>> {
        let exclude = format!("^{base}");
        let args = [
            "log",
            "--first-parent",
            "--no-decorate",
            "--no-show-signature",
            "--format=@%H",
            "--shortstat",
            "--end-of-options",
            head,
            &exclude,
            "--",
        ];
        Ok(parse_shortstat(&text(&self.git.run(&args)?)))
    }
}

fn parse_shortstat(out: &str) -> HashMap<String, CommitStats> {
    let mut stats = HashMap::new();
    let mut current: Option<String> = None;
    for line in out.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if let Some(sha) = line.strip_prefix('@') {
            stats.insert(sha.to_owned(), CommitStats::default());
            current = Some(sha.to_owned());
            continue;
        }
        let Some(entry) = current.as_ref().and_then(|sha| stats.get_mut(sha)) else {
            continue;
        };
        for part in line.split(',') {
            let mut words = part.split_whitespace();
            let count = words.next().and_then(|n| n.parse().ok()).unwrap_or(0);
            match words.next().unwrap_or_default() {
                w if w.starts_with("file") => entry.files = count,
                w if w.starts_with("insertion") => entry.additions = count,
                w if w.starts_with("deletion") => entry.deletions = count,
                _ => {}
            }
        }
    }
    stats
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_shortstat_lines_and_commits_without_changes() {
        let out = "@aaa\n\n 3 files changed, 10 insertions(+), 2 deletions(-)\n@bbb\n@ccc\n\n 1 file changed, 1 deletion(-)\n";
        let stats = parse_shortstat(out);
        assert_eq!(
            stats["aaa"],
            CommitStats {
                files: 3,
                additions: 10,
                deletions: 2
            }
        );
        assert_eq!(stats["bbb"], CommitStats::default());
        assert_eq!(
            stats["ccc"],
            CommitStats {
                files: 1,
                additions: 0,
                deletions: 1
            }
        );
    }
}
