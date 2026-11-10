use std::collections::HashMap;

use crate::model::{ChangeStatus, FileChange, FileKind, LineStats, Mode};
use crate::raw::{parse_numstat, parse_raw};
use crate::repo::Repo;
use crate::runner::{Result, parse_error, text};

/// What a diff compares. Revs are anything `git rev-parse` takes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffSpec {
    /// A commit against the working tree: staged, unstaged and untracked changes together.
    WorkingTree { base: String },
    /// Two commits; `from: None` is the empty tree (a root commit's parent).
    Revs { from: Option<String>, to: String },
}

/// Flags that fix what a diff compares and how it names things. Submodules are compared by
/// commit only.
pub(crate) const DIFF_FLAGS: &[&str] = &[
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-relative",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--find-renames",
    "--find-copies",
    "--ignore-submodules=dirty",
    "--submodule=short",
];

/// Patch shape; `--unified` implies a patch, so these stay out of `--raw`/`--numstat` runs.
pub(crate) const PATCH_FLAGS: &[&str] = &["--histogram", "--unified=3", "--inter-hunk-context=0"];

impl Repo {
    /// Every file that differs between `base` and the working tree, sorted by path. Untracked,
    /// non-ignored files are included (`untracked: true`, no `stats`); one that has the same
    /// content as a deleted file is paired with it as a rename.
    pub fn working_changes(&self, base: &str) -> Result<Vec<FileChange>> {
        let spec = DiffSpec::WorkingTree { base: base.into() };
        let mut changes = self.listed(&spec)?;
        let mut untracked = self.untracked()?;
        self.mark_symlinks(&mut untracked)?;
        changes.extend(untracked);
        self.hash_worktree(&mut changes)?;
        let mut changes = pair_exact_renames(changes);
        changes.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(changes)
    }

    /// Files that differ between two commits (`from: None` for the empty tree), sorted by path.
    pub fn changes_between(&self, from: Option<&str>, to: &str) -> Result<Vec<FileChange>> {
        let spec = DiffSpec::Revs {
            from: from.map(str::to_owned),
            to: to.into(),
        };
        let mut changes = self.listed(&spec)?;
        changes.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(changes)
    }

    pub(crate) fn spec_revs(&self, spec: &DiffSpec) -> Result<Vec<String>> {
        Ok(match spec {
            DiffSpec::WorkingTree { base } => vec![base.clone()],
            DiffSpec::Revs { from, to } => {
                let from = match from {
                    Some(from) => from.clone(),
                    None => self.empty_tree()?,
                };
                vec![from, to.clone()]
            }
        })
    }

    fn listed(&self, spec: &DiffSpec) -> Result<Vec<FileChange>> {
        let revs = self.spec_revs(spec)?;
        let run = |format: &str| -> Result<Vec<u8>> {
            let mut args = vec!["diff", format, "-z", "--no-abbrev"];
            args.extend_from_slice(DIFF_FLAGS);
            args.push("--end-of-options");
            args.extend(revs.iter().map(String::as_str));
            args.push("--");
            self.git.run(&args)
        };
        let raw = run("--raw")?;
        let mut changes = parse_raw(&raw).map_err(|e| parse_error(&["diff", "--raw"], e.0))?;
        let stats = parse_numstat(&run("--numstat")?)
            .map_err(|e| parse_error(&["diff", "--numstat"], e.0))?;
        for change in &mut changes {
            change.stats = stats.get(&change.path).copied();
        }
        Ok(changes)
    }

    fn untracked(&self) -> Result<Vec<FileChange>> {
        let out = self
            .git
            .run(&["ls-files", "-z", "--others", "--exclude-standard"])?;
        Ok(out
            .split(|b| *b == 0)
            .filter(|p| !p.is_empty())
            .map(|path| {
                let path = text(path);
                let nested_repo = path.ends_with('/');
                FileChange {
                    path: path.trim_end_matches('/').to_owned(),
                    old_path: None,
                    status: ChangeStatus::Added,
                    similarity: None,
                    old_mode: None,
                    new_mode: Some(if nested_repo {
                        Mode::GITLINK
                    } else {
                        Mode::FILE
                    }),
                    old_oid: None,
                    new_oid: None,
                    stats: None,
                    untracked: true,
                }
            })
            .collect())
    }

    /// `ls-files` does not say which untracked paths are symlinks, and `hash-object` would hash
    /// their targets; one shell loop over all of them finds out.
    fn mark_symlinks(&self, untracked: &mut [FileChange]) -> Result<()> {
        let files: Vec<&mut FileChange> = untracked
            .iter_mut()
            .filter(|c| c.kind() == FileKind::File && !c.path.contains('\n'))
            .collect();
        if files.is_empty() {
            return Ok(());
        }
        let input: String = files.iter().map(|c| format!("{}\n", c.path)).collect();
        let script =
            r#"while IFS= read -r p; do if [ -L "$p" ]; then printf '%s\n' "$p"; fi; done"#;
        let output = self.git.host.exec(
            ducky_host::ExecRequest::new(["sh", "-c", script])
                .cwd(self.info().toplevel.clone())
                .stdin(input)
                .timeout(self.git.timeout),
        )?;
        let links = text(&output.stdout);
        let links: std::collections::HashSet<&str> = links.lines().collect();
        for change in files {
            if links.contains(change.path.as_str()) {
                change.new_mode = Some(Mode::SYMLINK);
            }
        }
        Ok(())
    }

    /// Fills `new_oid` for working-tree content git did not hash: one `hash-object` for all.
    fn hash_worktree(&self, changes: &mut [FileChange]) -> Result<()> {
        let wanted: Vec<usize> = changes
            .iter()
            .enumerate()
            .filter(|(_, c)| {
                c.new_oid.is_none()
                    && c.status != ChangeStatus::Deleted
                    && c.kind() == FileKind::File
                    && !c.path.contains('\n')
            })
            .map(|(i, _)| i)
            .collect();
        if wanted.is_empty() {
            return Ok(());
        }
        let input: String = wanted
            .iter()
            .map(|i| format!("{}\n", changes[*i].path))
            .collect();
        let args = ["hash-object", "--stdin-paths"];
        let out = text(&self.git.run_with(&args, Some(input.into_bytes()))?);
        let oids: Vec<&str> = out.lines().collect();
        if oids.len() != wanted.len() {
            return Err(parse_error(
                &args,
                format!("{} ids for {} paths", oids.len(), wanted.len()),
            ));
        }
        for (index, oid) in wanted.into_iter().zip(oids) {
            changes[index].new_oid = Some(oid.to_owned());
        }
        Ok(())
    }
}

/// An untracked file with exactly a deleted file's content is that file, moved.
fn pair_exact_renames(changes: Vec<FileChange>) -> Vec<FileChange> {
    let mut deleted: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, change) in changes.iter().enumerate() {
        if change.status == ChangeStatus::Deleted
            && let Some(oid) = &change.old_oid
        {
            deleted.entry(oid.clone()).or_default().push(index);
        }
    }
    let mut paired: HashMap<usize, usize> = HashMap::new();
    for (index, change) in changes.iter().enumerate() {
        if !change.untracked {
            continue;
        }
        let Some(sources) = change.new_oid.as_ref().and_then(|o| deleted.get_mut(o)) else {
            continue;
        };
        let name = basename(&change.path);
        let pick = sources
            .iter()
            .position(|s| basename(&changes[*s].path) == name)
            .unwrap_or(0);
        if let Some(&source) = sources.get(pick) {
            sources.remove(pick);
            paired.insert(index, source);
        }
    }
    let sources: std::collections::HashSet<usize> = paired.values().copied().collect();
    changes
        .iter()
        .enumerate()
        .filter(|(index, _)| !sources.contains(index))
        .map(|(index, change)| match paired.get(&index) {
            Some(&source) => {
                let from = &changes[source];
                FileChange {
                    old_path: Some(from.path.clone()),
                    status: ChangeStatus::Renamed,
                    similarity: Some(100),
                    old_mode: from.old_mode,
                    old_oid: from.old_oid.clone(),
                    stats: Some(LineStats::Text {
                        additions: 0,
                        deletions: 0,
                    }),
                    ..change.clone()
                }
            }
            None => change.clone(),
        })
        .collect()
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(
        path: &str,
        status: ChangeStatus,
        old: Option<&str>,
        new: Option<&str>,
    ) -> FileChange {
        FileChange {
            path: path.into(),
            old_path: None,
            status,
            similarity: None,
            old_mode: old.map(|_| Mode::FILE),
            new_mode: new.map(|_| Mode::FILE),
            old_oid: old.map(str::to_owned),
            new_oid: new.map(str::to_owned),
            stats: None,
            untracked: status == ChangeStatus::Added,
        }
    }

    #[test]
    fn pairs_untracked_copies_of_deleted_files_preferring_the_same_name() {
        let changes = vec![
            change("a/x.txt", ChangeStatus::Deleted, Some("1"), None),
            change("b/y.txt", ChangeStatus::Deleted, Some("1"), None),
            change("c/y.txt", ChangeStatus::Added, None, Some("1")),
            change("d/new.txt", ChangeStatus::Added, None, Some("2")),
        ];
        let paired = pair_exact_renames(changes);
        let summary: Vec<(String, ChangeStatus, Option<String>)> = paired
            .iter()
            .map(|c| (c.path.clone(), c.status, c.old_path.clone()))
            .collect();
        assert_eq!(
            summary,
            [
                ("a/x.txt".into(), ChangeStatus::Deleted, None),
                (
                    "c/y.txt".into(),
                    ChangeStatus::Renamed,
                    Some("b/y.txt".into())
                ),
                ("d/new.txt".into(), ChangeStatus::Added, None),
            ]
        );
        assert_eq!(paired[1].similarity, Some(100));
    }
}
