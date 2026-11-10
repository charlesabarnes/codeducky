use std::collections::HashMap;

use ducky_git::{ChangeStatus as GitStatus, LineStats, Mode};
use ducky_github::pr_diff::{PrChanges, build_changes_between};
use ducky_review::{ChangeStatus, FileChange, FileStats};

use crate::changes::ChangedFile;
use crate::error::Result;
use crate::sides::PullBlobs;

/// A pull request file as the review lists it: git's model filled in from GitHub's.
pub(crate) fn changed_file(change: FileChange, stats: Option<FileStats>) -> ChangedFile {
    let status = match (change.status, &change.old_path) {
        (_, Some(_)) => GitStatus::Renamed,
        (ChangeStatus::Added, None) => GitStatus::Added,
        (ChangeStatus::Deleted, None) => GitStatus::Deleted,
        (ChangeStatus::Modified, None) => GitStatus::Modified,
    };
    let git = ducky_git::FileChange {
        path: change.path.clone(),
        old_path: change.old_path.clone(),
        status,
        similarity: None,
        old_mode: change.old_oid.as_ref().map(|_| Mode::FILE),
        new_mode: change.new_oid.as_ref().map(|_| Mode::FILE),
        old_oid: change.old_oid.as_ref().map(|o| o.as_str().to_owned()),
        new_oid: change.new_oid.as_ref().map(|o| o.as_str().to_owned()),
        stats: stats.and_then(|stats| match stats {
            FileStats::Lines {
                additions,
                deletions,
            } => Some(LineStats::Text {
                additions: additions.into(),
                deletions: deletions.into(),
            }),
            FileStats::Binary => Some(LineStats::Binary),
            FileStats::TooLarge => None,
        }),
        untracked: false,
    };
    ChangedFile { git, change, stats }
}

pub(crate) fn changed_files(built: &PrChanges) -> Vec<ChangedFile> {
    let stats: &HashMap<String, FileStats> = &built.stats;
    built
        .changes
        .iter()
        .map(|change| changed_file(change.clone(), stats.get(&change.path).copied()))
        .collect()
}

/// What a range of the pull request's commits changed, read through the API.
pub(crate) fn changes_between(
    blobs: &PullBlobs,
    base: &str,
    head: &str,
) -> Result<Vec<ChangedFile>> {
    let comparison = blobs.client.compare(&blobs.repo, base, head)?;
    let built = build_changes_between(&blobs.client, &blobs.repo, base, head, &comparison.files)?;
    blobs.add_metas(built.metas.clone());
    Ok(changed_files(&built))
}
