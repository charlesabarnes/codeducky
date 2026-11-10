//! A pull request's diff from the GitHub API alone, so a PR can be reviewed without a local
//! checkout: the file list with blob ids (looked up in batches through GraphQL), patches mapped
//! onto `ducky-git`'s diff model, and file contents read from blobs on demand.

use std::collections::{HashMap, HashSet};
use std::thread;

use ducky_git::patch::PatchError;
use ducky_git::{ChangeStatus as GitStatus, FileDiff, FileSide, parse_patch};
use ducky_review::diff::moved::{
    MAX_MOVE_LINES, MoveInput, MovedIndex, changed_runs, detect_moved_blocks,
};
use ducky_review::{ChangeStatus, FileChange, FileStats};
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::api::files::{FileStatus, PullFile};
use crate::api::pulls::PullDetail;
use crate::client::Client;
use crate::error::{GitHubError, Result};
use crate::remote::RepoRef;

pub use ducky_git::DEFAULT_MAX_BYTES;

const META_BATCH: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrSnapshot {
    pub repo: RepoRef,
    pub pull: PullDetail,
    /// GitHub's PR diff is three-dot: against the merge base, not the base branch tip.
    pub merge_base_sha: String,
    pub files: Vec<PullFile>,
}

pub fn load_pr_snapshot(client: &Client, repo: &RepoRef, number: u64) -> Result<PrSnapshot> {
    let pull = client.pull(repo, number)?;
    let (comparison, files) = thread::scope(|scope| {
        let files = scope.spawn(|| client.pull_files(repo, number));
        let comparison = client.compare(repo, &pull.base_sha, &pull.pr.head_sha);
        let files = files
            .join()
            .unwrap_or_else(|_| Err(GitHubError::network("the file list thread panicked")));
        (comparison, files)
    });
    Ok(PrSnapshot {
        repo: repo.clone(),
        merge_base_sha: comparison?.merge_base_sha,
        files: files?,
        pull,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlobMeta {
    /// `None` when not known (the file list named the blob but the lookup did not find it).
    pub size: Option<u64>,
    pub binary: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawBlobMeta {
    oid: Option<String>,
    byte_size: Option<u64>,
    is_binary: Option<bool>,
}

/// Blob id, size and binary flag per `commit:path` expression, through aliased GraphQL lookups
/// (100 per request). Missing paths map to `None`. Nothing is downloaded.
pub fn blob_metas(
    client: &Client,
    repo: &RepoRef,
    expressions: &[String],
) -> Result<HashMap<String, Option<(String, BlobMeta)>>> {
    let mut seen = HashSet::new();
    let unique: Vec<&String> = expressions.iter().filter(|e| seen.insert(*e)).collect();
    let mut result = HashMap::new();
    for batch in unique.chunks(META_BATCH) {
        let params: Vec<String> = (0..batch.len())
            .map(|i| format!("$e{i}: String!"))
            .collect();
        let fields: Vec<String> = (0..batch.len())
            .map(|i| {
                format!(
                    "b{i}: object(expression: $e{i}) {{ ... on Blob {{ oid byteSize isBinary }} }}"
                )
            })
            .collect();
        let query = format!(
            "query Blobs($owner: String!, $name: String!, {}) {{ repository(owner: $owner, name: $name) {{ {} }} }}",
            params.join(", "),
            fields.join("\n")
        );
        let mut variables = Map::new();
        variables.insert("owner".into(), repo.owner.clone().into());
        variables.insert("name".into(), repo.name.clone().into());
        for (i, expression) in batch.iter().enumerate() {
            variables.insert(format!("e{i}"), (*expression).clone().into());
        }
        #[derive(Deserialize)]
        struct Data {
            repository: Option<HashMap<String, Option<RawBlobMeta>>>,
        }
        let data: Data = client.graphql(&query, Value::Object(variables))?;
        let mut repository = data.repository.unwrap_or_default();
        for (i, expression) in batch.iter().enumerate() {
            let meta = repository
                .remove(&format!("b{i}"))
                .flatten()
                .and_then(|raw| {
                    let meta = BlobMeta {
                        size: raw.byte_size,
                        binary: raw.is_binary.unwrap_or(false),
                    };
                    raw.oid.map(|oid| (oid, meta))
                });
            result.insert((*expression).clone(), meta);
        }
    }
    Ok(result)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PrChanges {
    /// Sorted by path.
    pub changes: Vec<FileChange>,
    pub stats: HashMap<String, FileStats>,
    /// Size and binary flag per blob id, so contents can skip binary or huge blobs.
    pub metas: HashMap<String, BlobMeta>,
    pub moved: MovedIndex,
}

/// The review's changes between two commits whose changed files are listed (a pull request, a
/// commit, or a range). Patches are not trusted for content: GitHub leaves them out for binary,
/// large and truncated diffs. They only feed moved-block detection, where present.
pub fn build_changes_between(
    client: &Client,
    repo: &RepoRef,
    from_sha: &str,
    to_sha: &str,
    files: &[PullFile],
) -> Result<PrChanges> {
    let old_expr = |f: &PullFile| format!("{from_sha}:{}", f.old_path());
    let new_expr = |f: &PullFile| format!("{to_sha}:{}", f.path);
    let expressions: Vec<String> = files
        .iter()
        .filter(|f| f.has_old())
        .map(old_expr)
        .chain(files.iter().filter(|f| f.has_new()).map(new_expr))
        .collect();
    let found = blob_metas(client, repo, &expressions)?;

    let mut built = PrChanges::default();
    for file in files {
        let before = file
            .has_old()
            .then(|| found.get(&old_expr(file)).cloned().flatten())
            .flatten();
        let after = file
            .has_new()
            .then(|| {
                found.get(&new_expr(file)).cloned().flatten().or_else(|| {
                    let unknown = BlobMeta {
                        size: None,
                        binary: false,
                    };
                    file.sha.clone().map(|sha| (sha, unknown))
                })
            })
            .flatten();
        for (oid, meta) in before.iter().chain(after.iter()) {
            built.metas.insert(oid.clone(), *meta);
        }
        if before.is_none() && after.is_none() {
            continue;
        }
        let mut change = FileChange::new(
            &file.path,
            before.as_ref().map(|(oid, _)| oid.as_str()),
            after.as_ref().map(|(oid, _)| oid.as_str()),
        );
        if file.status == FileStatus::Renamed && before.is_some() && after.is_some() {
            change.old_path = file.previous_path.clone();
        }
        let metas = [&before, &after].map(|side| side.as_ref().map(|(_, m)| *m));
        let binary = metas.iter().flatten().any(|m| m.binary);
        let largest = metas
            .iter()
            .flatten()
            .filter_map(|m| m.size)
            .max()
            .unwrap_or(0);
        let stats = if binary {
            FileStats::Binary
        } else if largest > DEFAULT_MAX_BYTES as u64 {
            FileStats::TooLarge
        } else {
            FileStats::Lines {
                additions: file.additions,
                deletions: file.deletions,
            }
        };
        built.stats.insert(file.path.clone(), stats);
        built.changes.push(change);
    }
    built.changes.sort_by(|a, b| a.path.cmp(&b.path));
    built.moved = moved_from_patches(files);
    Ok(built)
}

pub fn build_pr_changes(client: &Client, snapshot: &PrSnapshot) -> Result<PrChanges> {
    build_changes_between(
        client,
        &snapshot.repo,
        &snapshot.merge_base_sha,
        &snapshot.pull.pr.head_sha,
        &snapshot.files,
    )
}

/// Moved blocks from the patches GitHub sent; files without a patch are left out.
pub fn moved_from_patches(files: &[PullFile]) -> MovedIndex {
    let mut runs = Vec::new();
    let mut total = 0;
    for file in files {
        let Some(patch) = &file.patch else { continue };
        let lines = ducky_review::patch::patch_diff_lines(patch);
        total += lines
            .iter()
            .filter(|l| l.kind != ducky_review::diff::LineKind::Context)
            .count();
        if total > MAX_MOVE_LINES {
            return MovedIndex::default();
        }
        let changed: Vec<_> = changed_runs(&lines).into_iter().cloned().collect();
        runs.push((file.path.as_str(), changed));
    }
    let inputs: Vec<MoveInput> = runs
        .iter()
        .map(|(path, lines)| MoveInput { path, lines })
        .collect();
    detect_moved_blocks(&inputs)
}

/// One side of a file from its blob: binary and oversized blobs are answered from their
/// metadata without downloading. `load` fetches the bytes (see [`crate::BlobCache`]).
pub fn read_side(
    oid: Option<&str>,
    metas: &HashMap<String, BlobMeta>,
    max_bytes: usize,
    load: impl FnOnce(&str) -> Result<Vec<u8>>,
) -> Result<Option<FileSide>> {
    let Some(oid) = oid else { return Ok(None) };
    let meta = metas.get(oid);
    if let Some(BlobMeta { binary: true, size }) = meta {
        return Ok(Some(FileSide::Binary {
            size: size.unwrap_or(0),
        }));
    }
    if let Some(size) = meta.and_then(|m| m.size).filter(|s| *s > max_bytes as u64) {
        return Ok(Some(FileSide::TooLarge { size }));
    }
    Ok(Some(FileSide::from_bytes(&load(oid)?, max_bytes)))
}

fn git_status(status: FileStatus) -> GitStatus {
    match status {
        FileStatus::Added => GitStatus::Added,
        FileStatus::Removed => GitStatus::Deleted,
        FileStatus::Renamed => GitStatus::Renamed,
        FileStatus::Copied => GitStatus::Copied,
        FileStatus::Modified | FileStatus::Changed | FileStatus::Unchanged => GitStatus::Modified,
    }
}

/// A PR file's patch as `ducky-git`'s [`FileDiff`]. Without a patch (binary, or a diff too large
/// for GitHub to show) there are no hunks; `binary` stays false because GitHub does not say
/// which, so use [`PrChanges::stats`] for that. Modes and blob ids are not known.
pub fn file_diff(file: &PullFile) -> Result<FileDiff, PatchError> {
    let hunks = match &file.patch {
        Some(patch) => {
            let text = format!("diff --git a/f b/f\n{patch}\n");
            parse_patch(text.as_bytes())?
                .into_iter()
                .next()
                .map(|parsed| parsed.hunks)
                .unwrap_or_default()
        }
        None => Vec::new(),
    };
    let status = git_status(file.status);
    Ok(FileDiff {
        old_path: (status != GitStatus::Added).then(|| file.old_path().to_owned()),
        new_path: (status != GitStatus::Deleted).then(|| file.path.clone()),
        status,
        old_mode: None,
        new_mode: None,
        similarity: None,
        dissimilarity: None,
        old_oid: None,
        new_oid: None,
        binary: false,
        hunks,
    })
}

/// [`FileChange`]'s status for a PR file: added, deleted or modified.
pub fn change_status(file: &PullFile) -> ChangeStatus {
    match file.status {
        FileStatus::Added | FileStatus::Copied => ChangeStatus::Added,
        FileStatus::Removed => ChangeStatus::Deleted,
        _ => ChangeStatus::Modified,
    }
}
