//! Patches for a change set, fetched in batches small enough for the host's output cap.
//!
//! The file list comes from `--raw`/`--numstat` (small). Patches are then asked for a batch of
//! files at a time, sized from their line counts. A batch whose output is cut (the host keeps
//! 8 MiB) is split in two and retried; a single file that alone does not fit comes back
//! `too_large`, with no diff.

use std::collections::HashMap;

use crate::changes::{DIFF_FLAGS, DiffSpec, PATCH_FLAGS};
use crate::model::{ChangeStatus, FileChange, FileKind, LineStats, Mode};
use crate::patch::{FileDiff, parse_patch};
use crate::repo::Repo;
use crate::runner::{GitError, Result, parse_error};

const BATCH_BYTES: u64 = 2 << 20;
const BATCH_FILES: usize = 100;
const BYTES_PER_LINE: u64 = 120;
const BYTES_PER_FILE: u64 = 600;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilePatch {
    /// The change's `path`.
    pub path: String,
    /// `None` when it was too large, or git printed nothing for it.
    pub diff: Option<FileDiff>,
    pub too_large: bool,
}

impl Repo {
    pub fn patch(&self, spec: &DiffSpec, change: &FileChange) -> Result<FilePatch> {
        Ok(self.patches(spec, std::slice::from_ref(change))?.remove(0))
    }

    /// One `FilePatch` per change, in the same order.
    pub fn patches(&self, spec: &DiffSpec, changes: &[FileChange]) -> Result<Vec<FilePatch>> {
        let mut found: HashMap<String, FilePatch> = HashMap::new();
        let mut tracked = Vec::new();
        for change in changes {
            if change.untracked {
                found.insert(change.path.clone(), self.untracked_patch(change)?);
            } else {
                tracked.push(change);
            }
        }
        for batch in batches(&tracked) {
            self.fetch(spec, batch, &mut found)?;
        }
        Ok(changes
            .iter()
            .map(|change| {
                found.remove(&change.path).unwrap_or(FilePatch {
                    path: change.path.clone(),
                    diff: None,
                    too_large: false,
                })
            })
            .collect())
    }

    fn fetch(
        &self,
        spec: &DiffSpec,
        batch: &[&FileChange],
        found: &mut HashMap<String, FilePatch>,
    ) -> Result<()> {
        let output = match self.patch_text(spec, batch) {
            Ok(output) => output,
            Err(GitError::TooLarge { .. }) if batch.len() > 1 => {
                let (left, right) = batch.split_at(batch.len() / 2);
                self.fetch(spec, left, found)?;
                return self.fetch(spec, right, found);
            }
            Err(GitError::TooLarge { .. }) => {
                found.insert(
                    batch[0].path.clone(),
                    FilePatch {
                        path: batch[0].path.clone(),
                        diff: None,
                        too_large: true,
                    },
                );
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        let mut diffs: HashMap<String, FileDiff> = output
            .into_iter()
            .map(|diff| (diff.path().to_owned(), diff))
            .collect();
        let mut missing = Vec::new();
        for change in batch {
            match diffs.remove(&change.path) {
                Some(diff) => {
                    found.insert(
                        change.path.clone(),
                        FilePatch {
                            path: change.path.clone(),
                            diff: Some(diff),
                            too_large: false,
                        },
                    );
                }
                None => missing.push(*change),
            }
        }
        // Rename pairing can differ when git sees only part of the change set; ask alone.
        if batch.len() > 1 {
            for change in missing {
                self.fetch(spec, &[change], found)?;
            }
        }
        Ok(())
    }

    fn patch_text(&self, spec: &DiffSpec, batch: &[&FileChange]) -> Result<Vec<FileDiff>> {
        let revs = self.spec_revs(spec)?;
        let mut args = vec!["diff"];
        args.extend_from_slice(DIFF_FLAGS);
        args.extend_from_slice(PATCH_FLAGS);
        args.push("--end-of-options");
        args.extend(revs.iter().map(String::as_str));
        args.push("--");
        args.extend(batch.iter().flat_map(|c| c.paths()));
        let output = self.git.run(&args)?;
        parse_patch(&output).map_err(|error| match error {
            crate::patch::PatchError::Truncated { .. } => GitError::TooLarge {
                command: "diff".into(),
            },
            other => parse_error(&["diff"], other.to_string()),
        })
    }

    fn untracked_patch(&self, change: &FileChange) -> Result<FilePatch> {
        let diff = match (change.status, change.kind()) {
            (ChangeStatus::Renamed, _) | (_, FileKind::Submodule) => Ok(Some(described(change))),
            _ => self.no_index_patch(change),
        };
        let (diff, too_large) = match diff {
            Ok(diff) => (diff, false),
            Err(GitError::TooLarge { .. }) => (None, true),
            Err(error) => return Err(error),
        };
        Ok(FilePatch {
            path: change.path.clone(),
            diff,
            too_large,
        })
    }

    /// An untracked file against nothing; `git diff --no-index` exits 1 when they differ.
    fn no_index_patch(&self, change: &FileChange) -> Result<Option<FileDiff>> {
        let mut args = vec!["diff", "--no-index"];
        args.extend(
            DIFF_FLAGS.iter().chain(PATCH_FLAGS).filter(|flag| {
                !flag.starts_with("--ignore-submodules") && **flag != "--no-relative"
            }),
        );
        args.extend(["--", "/dev/null", change.path.as_str()]);
        let output = self.git.output(&args, None)?;
        let output = self.git.expect(&args, output, &[0, 1])?;
        let mut diffs = parse_patch(&output).map_err(|error| match error {
            crate::patch::PatchError::Truncated { .. } => GitError::TooLarge {
                command: "diff".into(),
            },
            other => parse_error(&args, other.to_string()),
        })?;
        Ok((!diffs.is_empty()).then(|| diffs.remove(0)))
    }
}

/// A diff that needs no git: an untracked file paired by content, or a nested repository.
fn described(change: &FileChange) -> FileDiff {
    FileDiff {
        old_path: change.old_path.clone(),
        new_path: Some(change.path.clone()),
        status: change.status,
        old_mode: change.old_mode,
        new_mode: change.new_mode.or(Some(Mode::FILE)),
        similarity: change.similarity,
        dissimilarity: None,
        old_oid: change.old_oid.clone(),
        new_oid: change.new_oid.clone(),
        binary: false,
        hunks: Vec::new(),
    }
}

fn estimate(change: &FileChange) -> u64 {
    BYTES_PER_FILE
        + match change.stats {
            Some(LineStats::Text {
                additions,
                deletions,
            }) => (additions + deletions) * BYTES_PER_LINE,
            Some(LineStats::Binary) => 0,
            None => BATCH_BYTES,
        }
}

fn batches<'a>(changes: &'a [&'a FileChange]) -> Vec<&'a [&'a FileChange]> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut bytes = 0;
    for (index, change) in changes.iter().enumerate() {
        let size = estimate(change);
        let full = index > start && (bytes + size > BATCH_BYTES || index - start >= BATCH_FILES);
        if full {
            out.push(&changes[start..index]);
            start = index;
            bytes = 0;
        }
        bytes += size;
    }
    if start < changes.len() {
        out.push(&changes[start..]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(lines: u64) -> FileChange {
        FileChange {
            path: format!("f{lines}"),
            old_path: None,
            status: ChangeStatus::Modified,
            similarity: None,
            old_mode: None,
            new_mode: None,
            old_oid: None,
            new_oid: None,
            stats: Some(LineStats::Text {
                additions: lines,
                deletions: 0,
            }),
            untracked: false,
        }
    }

    #[test]
    fn batches_split_by_estimated_size_and_count() {
        let big = change(BATCH_BYTES / BYTES_PER_LINE);
        let small: Vec<FileChange> = (0..250).map(|_| change(1)).collect();
        let mut refs: Vec<&FileChange> = vec![&big];
        refs.extend(small.iter());
        let sizes: Vec<usize> = batches(&refs).iter().map(|b| b.len()).collect();
        assert_eq!(sizes, [1, 100, 100, 50]);
        assert!(batches(&[]).is_empty());
    }
}
