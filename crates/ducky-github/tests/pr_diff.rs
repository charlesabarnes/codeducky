mod support;

use std::cell::RefCell;
use std::collections::HashMap;

use ducky_git::{ChangeStatus as GitStatus, FileSide, LineKind};
use ducky_github::pr_diff::{
    BlobMeta, PrChanges, build_changes_between, file_diff, load_pr_snapshot, moved_from_patches,
    read_side,
};
use ducky_github::{BlobCache, FileStatus, PullFile, RepoRef, Side};
use ducky_review::{ChangeStatus, FileChange, FileStats};
use serde_json::{Map, Value, json};
use support::{FakeGitHub, Reply};

const HEAD: &str = "hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh";
const MERGE_BASE: &str = "mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm";
const BASE_TIP: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn acme() -> RepoRef {
    RepoRef::new("acme", "api")
}

fn file(
    path: &str,
    status: FileStatus,
    patch: Option<&str>,
    sha: &str,
    adds: u32,
    dels: u32,
) -> PullFile {
    PullFile {
        sha: Some(sha.into()),
        additions: adds,
        deletions: dels,
        ..PullFile::new(path, status, patch)
    }
}

fn files() -> Vec<PullFile> {
    vec![
        file(
            "src/big.ts",
            FileStatus::Modified,
            None,
            "new-big",
            400,
            380,
        ),
        PullFile {
            previous_path: Some("src/sum.ts".into()),
            ..file(
                "src/totals.ts",
                FileStatus::Renamed,
                Some("@@ -1,2 +1,2 @@\n-a\n+b\n c"),
                "new-totals",
                1,
                1,
            )
        },
        file("logo.png", FileStatus::Modified, None, "new-png", 0, 0),
        file(
            "src/added.ts",
            FileStatus::Added,
            Some("@@ -0,0 +1 @@\n+x"),
            "new-added",
            1,
            0,
        ),
        file(
            "src/gone.ts",
            FileStatus::Removed,
            Some("@@ -1 +0,0 @@\n-y"),
            "old-gone",
            0,
            1,
        ),
        file("huge.json", FileStatus::Added, None, "new-huge", 90000, 0),
    ]
}

fn blobs() -> HashMap<String, Value> {
    let meta = |oid: &str, size: u64, binary: bool| json!({ "oid": oid, "byteSize": size, "isBinary": binary });
    HashMap::from([
        (
            format!("{MERGE_BASE}:src/big.ts"),
            meta("old-big", 9000, false),
        ),
        (format!("{HEAD}:src/big.ts"), meta("new-big", 9100, false)),
        (
            format!("{MERGE_BASE}:src/sum.ts"),
            meta("old-sum", 20, false),
        ),
        (
            format!("{HEAD}:src/totals.ts"),
            meta("new-totals", 22, false),
        ),
        (
            format!("{MERGE_BASE}:logo.png"),
            meta("old-png", 4000, true),
        ),
        (format!("{HEAD}:logo.png"), meta("new-png", 4100, true)),
        (format!("{HEAD}:src/added.ts"), meta("new-added", 2, false)),
        (
            format!("{MERGE_BASE}:src/gone.ts"),
            meta("old-gone", 2, false),
        ),
        (
            format!("{HEAD}:huge.json"),
            meta("new-huge", 5 * 1024 * 1024, false),
        ),
    ])
}

fn blob_server(lookup: impl Fn(&str) -> Value + Send + Sync + 'static) -> FakeGitHub {
    FakeGitHub::start(move |call, _| {
        if call.path != "/graphql" {
            return None;
        }
        let mut repository = Map::new();
        for (key, value) in call.variables().as_object()? {
            if let Some(index) = key.strip_prefix('e') {
                repository.insert(format!("b{index}"), lookup(value.as_str()?));
            }
        }
        Some(Reply::json(json!({ "data": { "repository": repository } })))
    })
}

fn built() -> (FakeGitHub, PrChanges) {
    let table = blobs();
    let server = blob_server(move |expr| table.get(expr).cloned().unwrap_or(Value::Null));
    let built =
        build_changes_between(&server.client(), &acme(), MERGE_BASE, HEAD, &files()).unwrap();
    (server, built)
}

#[test]
fn loads_the_pr_its_merge_base_and_files() {
    let server = FakeGitHub::start(|call, _| match call.path.as_str() {
        "/repos/acme/api/pulls/7" => Some(Reply::json(json!({
            "number": 7, "title": "T", "html_url": "u", "state": "open", "user": { "login": "octo" },
            "head": { "sha": HEAD, "ref": "feature" }, "base": { "sha": BASE_TIP, "ref": "main" },
            "created_at": "", "updated_at": ""
        }))),
        p if p.starts_with("/repos/acme/api/compare/") => Some(Reply::json(json!({
            "status": "ahead", "ahead_by": 1, "behind_by": 0, "merge_base_commit": { "sha": MERGE_BASE }
        }))),
        "/repos/acme/api/pulls/7/files" => Some(Reply::json(json!([
            { "filename": "a.ts", "status": "modified", "sha": "x", "additions": 1, "deletions": 0 }
        ]))),
        _ => None,
    });
    let snapshot = load_pr_snapshot(&server.client(), &acme(), 7).unwrap();
    assert_eq!(snapshot.merge_base_sha, MERGE_BASE);
    assert_eq!(
        (
            snapshot.pull.pr.number,
            snapshot.pull.author.as_str(),
            snapshot.pull.pr.head_sha.as_str()
        ),
        (7, "octo", HEAD)
    );
    assert_eq!(
        (
            snapshot.files[0].path.as_str(),
            snapshot.files[0].sha.as_deref(),
            snapshot.files[0].additions
        ),
        ("a.ts", Some("x"), 1)
    );
    let compare = server
        .calls()
        .into_iter()
        .find(|c| c.path.contains("/compare/"))
        .unwrap();
    assert_eq!(
        compare.path,
        format!("/repos/acme/api/compare/{BASE_TIP}...{HEAD}")
    );
}

#[test]
fn builds_changes_from_blob_lookups_not_patches() {
    let (server, built) = built();
    assert_eq!(server.calls().len(), 1);
    let by_path: HashMap<&str, &FileChange> =
        built.changes.iter().map(|c| (c.path.as_str(), c)).collect();
    assert_eq!(
        *by_path["src/big.ts"],
        FileChange::new("src/big.ts", Some("old-big"), Some("new-big"))
    );
    let totals = by_path["src/totals.ts"];
    assert_eq!(
        (totals.status, totals.old_path.as_deref()),
        (ChangeStatus::Modified, Some("src/sum.ts"))
    );
    assert_eq!(totals.old_oid.as_ref().unwrap().as_str(), "old-sum");
    assert_eq!(
        (
            by_path["src/added.ts"].status,
            by_path["src/added.ts"].old_oid.is_none()
        ),
        (ChangeStatus::Added, true)
    );
    assert_eq!(
        (
            by_path["src/gone.ts"].status,
            by_path["src/gone.ts"].new_oid.is_none()
        ),
        (ChangeStatus::Deleted, true)
    );
    assert_eq!(
        built.stats["src/big.ts"],
        FileStats::Lines {
            additions: 400,
            deletions: 380
        }
    );
    assert_eq!(built.stats["logo.png"], FileStats::Binary);
    assert_eq!(built.stats["huge.json"], FileStats::TooLarge);
    let paths: Vec<&str> = built.changes.iter().map(|c| c.path.as_str()).collect();
    let mut sorted = paths.clone();
    sorted.sort();
    assert_eq!(paths, sorted);
}

#[test]
fn reads_contents_on_demand_and_never_downloads_binary_or_oversized_blobs() {
    let (_server, built) = built();
    let loaded = RefCell::new(Vec::new());
    let load = |oid: &str| {
        loaded.borrow_mut().push(oid.to_owned());
        Ok(if oid == "old-big" {
            b"one\ntwo\n".to_vec()
        } else {
            b"one\nthree\n".to_vec()
        })
    };
    let max = ducky_github::pr_diff::DEFAULT_MAX_BYTES;
    let side = |oid: Option<&str>, max: usize| read_side(oid, &built.metas, max, load).unwrap();
    let text = |s: Option<FileSide>| match s {
        Some(FileSide::Text { text, .. }) => text,
        other => panic!("expected text, got {other:?}"),
    };
    assert_eq!(text(side(Some("old-big"), max)), "one\ntwo\n");
    assert_eq!(text(side(Some("new-big"), max)), "one\nthree\n");
    assert_eq!(
        side(Some("old-png"), max),
        Some(FileSide::Binary { size: 4000 })
    );
    assert_eq!(side(None, max), None);
    assert_eq!(
        side(Some("new-huge"), max),
        Some(FileSide::TooLarge {
            size: 5 * 1024 * 1024
        })
    );
    assert_eq!(*loaded.borrow(), ["old-big", "new-big"]);
    assert!(
        matches!(
            side(Some("new-huge"), 50 * 1024 * 1024),
            Some(FileSide::Text { .. })
        ),
        "load anyway"
    );
}

#[test]
fn sniffs_binary_content_the_metadata_did_not_flag() {
    let (_server, built) = built();
    let side = read_side(Some("new-added"), &built.metas, 1 << 20, |_| {
        Ok(vec![0, 1, 2])
    })
    .unwrap();
    assert_eq!(side, Some(FileSide::Binary { size: 3 }));
    assert_eq!(
        built.metas["new-added"],
        BlobMeta {
            size: Some(2),
            binary: false
        }
    );
}

#[test]
fn fetches_and_caches_a_blob() {
    let server = FakeGitHub::start(|call, _| {
        (call.path == "/repos/acme/api/git/blobs/abc")
            .then(|| Reply::json(json!({ "content": "aGVs\nbG8K", "encoding": "base64" })))
    });
    let cache = BlobCache::default();
    let client = server.client();
    assert_eq!(
        cache.load(&client, &acme(), "abc").unwrap().as_slice(),
        b"hello\n"
    );
    cache.load(&client, &acme(), "abc").unwrap();
    assert_eq!(server.calls().len(), 1);
}

#[test]
fn splits_lookups_into_batches_of_100() {
    let many: Vec<PullFile> = (0..150)
        .map(|i| {
            file(
                &format!("f{i}.ts"),
                FileStatus::Added,
                None,
                &format!("s{i}"),
                1,
                0,
            )
        })
        .collect();
    let server = blob_server(|expr| {
        let path = expr.split(':').nth(1).unwrap_or_default();
        json!({ "oid": format!("oid-{path}"), "byteSize": 1, "isBinary": false })
    });
    let built = build_changes_between(&server.client(), &acme(), MERGE_BASE, HEAD, &many).unwrap();
    assert_eq!(server.calls().len(), 2);
    assert_eq!(built.changes.len(), 150);
    let f0 = built.changes.iter().find(|c| c.path == "f0.ts").unwrap();
    assert_eq!(f0.new_oid.as_ref().unwrap().as_str(), "oid-f0.ts");
}

#[test]
fn finds_moved_blocks_in_the_patches_it_has() {
    let block = [
        "export function total(items) {",
        "  return items.reduce((sum, item) => sum + item.cents, 0)",
        "}",
    ];
    let removed: Vec<String> = block.iter().map(|l| format!("-{l}")).collect();
    let added: Vec<String> = block.iter().map(|l| format!("+{l}")).collect();
    let moved = moved_from_patches(&[
        PullFile::new(
            "a.ts",
            FileStatus::Modified,
            Some(&format!("@@ -1,4 +1,1 @@\n keep\n{}", removed.join("\n"))),
        ),
        PullFile::new(
            "b.ts",
            FileStatus::Modified,
            Some(&format!("@@ -1,1 +1,4 @@\n other\n{}", added.join("\n"))),
        ),
        PullFile::new("c.bin", FileStatus::Modified, None),
    ]);
    let a = &moved["a.ts"][0];
    assert_eq!(
        (
            a.side,
            a.start,
            a.end,
            a.other.path.as_str(),
            a.other.side,
            a.other.line
        ),
        (Side::Old, 2, 4, "b.ts", Side::New, 2)
    );
    let b = &moved["b.ts"][0];
    assert_eq!((b.side, b.start, b.end), (Side::New, 2, 4));
}

#[test]
fn maps_patches_onto_the_git_diff_model() {
    let renamed = PullFile {
        previous_path: Some("src/sum.ts".into()),
        ..PullFile::new(
            "src/totals.ts",
            FileStatus::Renamed,
            Some(
                "@@ -1,3 +1,3 @@ fn total\n one\n-two\n+TWO\n three\n\\ No newline at end of file",
            ),
        )
    };
    let diff = file_diff(&renamed).unwrap();
    assert_eq!(
        (
            diff.status,
            diff.old_path.as_deref(),
            diff.new_path.as_deref()
        ),
        (
            GitStatus::Renamed,
            Some("src/sum.ts"),
            Some("src/totals.ts")
        )
    );
    let hunk = &diff.hunks[0];
    assert_eq!(
        (hunk.old_start, hunk.new_start, hunk.section.as_str()),
        (1, 1, "fn total")
    );
    let kinds: Vec<LineKind> = hunk.lines.iter().map(|l| l.kind).collect();
    assert_eq!(
        kinds,
        [
            LineKind::Context,
            LineKind::Removed,
            LineKind::Added,
            LineKind::Context
        ]
    );
    assert_eq!(
        (hunk.lines[2].new_line, hunk.lines[2].text.as_str()),
        (Some(2), "TWO")
    );
    assert!(hunk.lines[3].no_newline);
    assert_eq!((diff.additions(), diff.deletions()), (1, 1));

    let added = file_diff(&PullFile::new(
        "new.ts",
        FileStatus::Added,
        Some("@@ -0,0 +1 @@\n+x"),
    ))
    .unwrap();
    assert_eq!(
        (added.status, added.old_path, added.new_path.as_deref()),
        (GitStatus::Added, None, Some("new.ts"))
    );
    let removed = file_diff(&PullFile::new("old.ts", FileStatus::Removed, None)).unwrap();
    assert_eq!(
        (removed.status, removed.new_path, removed.hunks.len()),
        (GitStatus::Deleted, None, 0)
    );
    assert!(
        file_diff(&PullFile::new(
            "bad.ts",
            FileStatus::Modified,
            Some("@@ -1,3 +1,3 @@\n one")
        ))
        .is_err()
    );
}
