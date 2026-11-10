mod support;

use std::sync::Arc;

use ducky_git::{
    ChangeStatus, DiffSpec, FileChange, FileKind, FileSide, GitError, LineKind, LineStats, Mode,
    Repo,
};
use ducky_host::LocalHost;
use support::{CappedHost, TestRepo};

fn by_path<'a>(changes: &'a [FileChange], path: &str) -> &'a FileChange {
    changes
        .iter()
        .find(|c| c.path == path)
        .unwrap_or_else(|| panic!("no change for {path}: {changes:#?}"))
}

#[test]
fn opens_from_a_subfolder_and_knows_worktrees() {
    let repo = TestRepo::new();
    repo.write("deep/er/file.txt", "x\n");
    repo.commit_all("init");
    let sub = repo.path.join("deep/er");
    let opened = Repo::open(Arc::new(LocalHost), sub.to_str().unwrap()).unwrap();
    let info = opened.info();
    assert_eq!(info.toplevel, repo.path.to_str().unwrap());
    assert!(!info.is_linked_worktree());

    let linked = repo.dir.path().canonicalize().unwrap().join("linked tree");
    repo.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "side",
        linked.to_str().unwrap(),
    ]);
    let other = Repo::open(Arc::new(LocalHost), linked.to_str().unwrap()).unwrap();
    assert!(other.info().is_linked_worktree());
    assert_eq!(other.info().common_dir, info.common_dir);
    let worktrees = opened.worktrees().unwrap();
    assert_eq!(worktrees.len(), 2);
    assert_eq!(worktrees[1].branch.as_deref(), Some("side"));
    assert_eq!(worktrees[1].path, linked.to_str().unwrap());

    let outside = tempfile::tempdir().unwrap();
    assert!(matches!(
        Repo::open(Arc::new(LocalHost), outside.path().to_str().unwrap()),
        Err(GitError::NotARepository { .. })
    ));
}

#[test]
fn head_branches_default_base_and_merge_base() {
    let upstream = TestRepo::new();
    upstream.write("a.txt", "a\n");
    let first = upstream.commit_all("first");
    upstream.write("a.txt", "a\nb\n");
    let main_tip = upstream.commit_all("second");

    let parent = upstream.dir.path().canonicalize().unwrap();
    TestRepo::git_in(
        &parent,
        &["clone", "-q", upstream.path.to_str().unwrap(), "clone"],
    );
    let clone = TestRepo {
        dir: tempfile::tempdir().unwrap(),
        path: parent.join("clone"),
    };
    clone.harden();
    clone.git(&["checkout", "-q", "-b", "feature", &first]);
    clone.write("f.txt", "f\n");
    let feature_tip = clone.commit_all("feature");

    let repo = clone.open();
    let head = repo.head().unwrap();
    assert_eq!(head.branch.as_deref(), Some("feature"));
    assert_eq!(head.sha.as_deref(), Some(feature_tip.as_str()));

    let names: Vec<String> = repo
        .branches()
        .unwrap()
        .into_iter()
        .map(|b| b.name)
        .collect();
    assert_eq!(names, ["feature", "main", "origin/main"]);
    assert_eq!(repo.default_base().unwrap().as_deref(), Some("origin/main"));
    assert_eq!(
        repo.merge_base("HEAD", "origin/main").unwrap().as_deref(),
        Some(first.as_str())
    );
    assert_eq!(repo.resolve("origin/main").unwrap(), Some(main_tip));
    assert_eq!(repo.resolve("no-such-branch").unwrap(), None);
    assert!(repo.is_ancestor(&first, "HEAD").unwrap());
    assert!(
        repo.remote_url("origin")
            .unwrap()
            .unwrap()
            .ends_with("work")
    );
    assert_eq!(repo.remote_url("nope").unwrap(), None);

    assert_eq!(repo.head_move_since(&first).unwrap().commits, Some(1));
    assert!(repo.head_move_since("deadbeef").unwrap().rewritten);

    clone.git(&["checkout", "-q", "--detach", "HEAD"]);
    assert_eq!(repo.head().unwrap().branch, None);
}

#[test]
fn unborn_and_unrelated_histories() {
    let repo = TestRepo::new();
    let opened = repo.open();
    let head = opened.head().unwrap();
    assert_eq!(head.branch.as_deref(), Some("main"));
    assert_eq!(head.sha, None);
    assert_eq!(opened.default_base().unwrap(), None);

    repo.write("a", "a\n");
    repo.commit_all("one");
    repo.git(&["checkout", "-q", "--orphan", "other"]);
    repo.write("b", "b\n");
    repo.commit_all("two");
    assert_eq!(opened.merge_base("main", "other").unwrap(), None);
}

/// A base commit, then every kind of working-tree change on top.
fn busy_worktree() -> (TestRepo, String) {
    let repo = TestRepo::new();
    repo.write("keep.txt", "same\n");
    repo.write("old name.txt", "1\n2\n3\n4\n5\n6\n7\n8\n");
    repo.write("moved by hand.txt", "exactly this content\n");
    repo.write("gone.txt", "bye\n");
    repo.write("crlf.txt", "one\r\ntwo\r\n");
    repo.write("img.bin", [0u8, 1, 2, 3]);
    repo.write("run.sh", "#!/bin/sh\n");
    repo.write("tail.txt", "no newline");
    let base = repo.commit_all("base");

    repo.git(&["mv", "old name.txt", "new näme.txt"]);
    repo.write("new näme.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n");
    std::fs::create_dir_all(repo.path.join("dir")).unwrap();
    std::fs::rename(
        repo.path.join("moved by hand.txt"),
        repo.path.join("dir/hand moved.txt"),
    )
    .unwrap();
    std::fs::remove_file(repo.path.join("gone.txt")).unwrap();
    repo.write("crlf.txt", "one\r\nTWO\r\n");
    repo.write("img.bin", [0u8, 9, 9]);
    repo.git(&["update-index", "--chmod=+x", "run.sh"]);
    let mut perms = std::fs::metadata(repo.path.join("run.sh"))
        .unwrap()
        .permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o755);
    std::fs::set_permissions(repo.path.join("run.sh"), perms).unwrap();
    repo.write("tail.txt", "no newline, still");
    repo.write("staged.txt", "staged\n");
    repo.git(&["add", "staged.txt"]);
    repo.write("staged.txt", "staged\nthen edited\n");
    repo.write("untracked/ünï code.md", "# hi\n");
    repo.write("empty", "");
    repo.write(".gitignore", "ignored.log\n");
    repo.write("ignored.log", "noise\n");
    std::os::unix::fs::symlink("keep.txt", repo.path.join("link")).unwrap();
    (repo, base)
}

#[test]
fn working_changes_cover_staged_unstaged_and_untracked() {
    let (repo, base) = busy_worktree();
    let changes = repo.open().working_changes(&base).unwrap();
    let paths: Vec<&str> = changes.iter().map(|c| c.path.as_str()).collect();
    assert_eq!(
        paths,
        [
            ".gitignore",
            "crlf.txt",
            "dir/hand moved.txt",
            "empty",
            "gone.txt",
            "img.bin",
            "link",
            "new näme.txt",
            "run.sh",
            "staged.txt",
            "tail.txt",
            "untracked/ünï code.md",
        ]
    );

    let renamed = by_path(&changes, "new näme.txt");
    assert_eq!(renamed.status, ChangeStatus::Renamed);
    assert_eq!(renamed.old_path.as_deref(), Some("old name.txt"));
    assert!(renamed.similarity.unwrap() >= 50);
    assert_eq!(
        renamed.stats,
        Some(LineStats::Text {
            additions: 1,
            deletions: 0
        })
    );

    let by_hand = by_path(&changes, "dir/hand moved.txt");
    assert_eq!(by_hand.status, ChangeStatus::Renamed);
    assert_eq!(by_hand.old_path.as_deref(), Some("moved by hand.txt"));
    assert!(by_hand.untracked);

    assert_eq!(by_path(&changes, "gone.txt").status, ChangeStatus::Deleted);
    assert!(by_path(&changes, "img.bin").is_binary());
    let script = by_path(&changes, "run.sh");
    assert!(script.mode_changed());
    assert_eq!(script.new_mode, Some(Mode::EXECUTABLE));

    let staged = by_path(&changes, "staged.txt");
    assert_eq!(staged.status, ChangeStatus::Added);
    assert!(!staged.untracked);
    assert_eq!(
        staged.stats,
        Some(LineStats::Text {
            additions: 2,
            deletions: 0
        })
    );

    let untracked = by_path(&changes, "untracked/ünï code.md");
    assert!(untracked.untracked);
    assert_eq!(untracked.stats, None);
    let link = by_path(&changes, "link");
    assert_eq!(link.kind(), FileKind::Symlink);
    assert_eq!(link.new_oid, None);

    let worktree_oid = repo.git(&["hash-object", "crlf.txt"]);
    assert_eq!(
        by_path(&changes, "crlf.txt").new_oid.as_deref(),
        Some(worktree_oid.as_str())
    );
    assert!(
        changes
            .iter()
            .filter(|c| c.status != ChangeStatus::Deleted && c.kind() == FileKind::File)
            .all(|c| c.new_oid.is_some())
    );
}

#[test]
fn patches_parse_for_every_kind_of_change() {
    let (repo, base) = busy_worktree();
    let opened = repo.open();
    let changes = opened.working_changes(&base).unwrap();
    let spec = DiffSpec::WorkingTree { base };
    let patches = opened.patches(&spec, &changes).unwrap();
    assert_eq!(patches.len(), changes.len());
    let diff = |path: &str| {
        patches
            .iter()
            .find(|p| p.path == path)
            .and_then(|p| p.diff.clone())
            .unwrap_or_else(|| panic!("no diff for {path}"))
    };

    let renamed = diff("new näme.txt");
    assert_eq!(renamed.old_path.as_deref(), Some("old name.txt"));
    assert_eq!(renamed.hunks[0].lines.last().unwrap().text, "9");
    assert_eq!(renamed.hunks[0].lines.last().unwrap().new_line, Some(9));
    assert_eq!(renamed.hunks[0].lines.len(), 4, "three lines of context");

    let crlf = diff("crlf.txt");
    let removed: Vec<&str> = crlf.hunks[0]
        .lines
        .iter()
        .filter(|l| l.kind == LineKind::Removed)
        .map(|l| l.text.as_str())
        .collect();
    assert_eq!(removed, ["two\r"]);

    let tail = diff("tail.txt");
    assert!(tail.hunks[0].lines.iter().all(|l| l.no_newline));

    assert!(diff("img.bin").binary);
    let script = diff("run.sh");
    assert_eq!(
        (script.old_mode, script.new_mode),
        (Some(Mode::FILE), Some(Mode::EXECUTABLE))
    );
    assert_eq!(diff("gone.txt").status, ChangeStatus::Deleted);

    let untracked = diff("untracked/ünï code.md");
    assert_eq!(untracked.status, ChangeStatus::Added);
    assert_eq!(untracked.hunks[0].lines[0].text, "# hi");
    assert_eq!(diff("empty").status, ChangeStatus::Added);
    assert!(diff("empty").hunks.is_empty());
    let by_hand = diff("dir/hand moved.txt");
    assert_eq!(by_hand.status, ChangeStatus::Renamed);
    assert!(by_hand.hunks.is_empty());
    assert_eq!(diff("link").kind(), FileKind::Symlink);
}

#[test]
fn commits_in_a_range_with_a_merge_and_per_commit_changes() {
    let repo = TestRepo::new();
    repo.write("a.txt", "a\n");
    let root = repo.commit_all("root");
    repo.git(&["checkout", "-q", "-b", "feature"]);
    repo.write("b.txt", "b\n");
    let first = repo.commit_all("Add b\n\nWith a body.");
    repo.git(&["checkout", "-q", "main"]);
    repo.write("a.txt", "a\nmain\n");
    repo.commit_all("main moves");
    repo.git(&["checkout", "-q", "feature"]);
    repo.git(&["merge", "-q", "--no-edit", "main"]);
    repo.write("b.txt", "b\nc\n");
    let last = repo.commit_all("Edit b");

    let opened = repo.open();
    let list = opened.commits("main", "HEAD", 300).unwrap();
    let summaries: Vec<&str> = list.commits.iter().map(|c| c.summary()).collect();
    assert_eq!(
        summaries,
        ["Add b", "Merge branch 'main' into feature", "Edit b"]
    );
    assert!(!list.truncated);
    assert!(list.commits[1].is_merge());
    assert_eq!(list.commits[0].sha, first);
    assert_eq!(list.commits[0].message, "Add b\n\nWith a body.");
    assert_eq!(list.commits[0].author_name, "Tester");
    assert_eq!(list.commits[0].author_time, 1_767_323_045);
    assert_eq!(list.commits[2].sha, last);

    let short = opened.commits("main", "HEAD", 2).unwrap();
    assert!(short.truncated);
    assert_eq!(short.commits.len(), 2);
    assert_eq!(short.commits[1].sha, last);

    let edits = opened.commit_changes(&list.commits[2]).unwrap();
    assert_eq!(edits.len(), 1);
    assert_eq!(edits[0].path, "b.txt");

    let all = opened.commits(&root, "HEAD", 300).unwrap();
    let root_commit = opened.commits(&first, &root, 10).unwrap();
    assert!(root_commit.commits.is_empty());
    let from_empty = opened.changes_between(None, &root).unwrap();
    assert_eq!(from_empty[0].status, ChangeStatus::Added);
    let spec = DiffSpec::Revs {
        from: None,
        to: root.clone(),
    };
    let patch = opened.patch(&spec, &from_empty[0]).unwrap();
    assert_eq!(patch.diff.unwrap().hunks[0].lines[0].text, "a");
    assert_eq!(all.commits.len(), 3);
}

#[test]
fn contents_at_revs_and_in_the_worktree() {
    let repo = TestRepo::new();
    repo.write("a.txt", "one\r\ntwo");
    repo.write("bin", [0u8, 159, 146, 150]);
    let base = repo.commit_all("base");
    repo.write("a.txt", "changed\n");

    let opened = repo.open();
    assert_eq!(
        opened.read_at(&base, "a.txt").unwrap().unwrap(),
        b"one\r\ntwo"
    );
    assert_eq!(opened.read_at(&base, "missing").unwrap(), None);
    assert_eq!(
        opened.read_at("HEAD", "bin").unwrap().unwrap(),
        [0, 159, 146, 150]
    );
    assert_eq!(
        opened.read_worktree("a.txt").unwrap().unwrap(),
        b"changed\n"
    );
    assert_eq!(opened.read_worktree("missing").unwrap(), None);
    assert_eq!(opened.blob_at("HEAD", "a.txt").unwrap().unwrap().size, 8);

    assert_eq!(
        opened.side_at("HEAD", "bin", 1024).unwrap(),
        Some(FileSide::Binary { size: 4 })
    );
    assert_eq!(
        opened.side_at("HEAD", "a.txt", 4).unwrap(),
        Some(FileSide::TooLarge { size: 8 })
    );
    assert_eq!(
        opened.side_in_worktree("a.txt", 1024).unwrap(),
        Some(FileSide::Text {
            text: "changed\n".into(),
            size: 8
        })
    );
}

#[test]
fn capped_output_splits_batches_and_marks_files_too_large() {
    let repo = TestRepo::new();
    repo.write("big.txt", "");
    for i in 0..5 {
        repo.write(&format!("small{i}.txt"), "x\n");
    }
    let base = repo.commit_all("base");
    let big: String = (0..2000).map(|i| format!("line {i}\n")).collect();
    repo.write("big.txt", &big);
    for i in 0..5 {
        repo.write(&format!("small{i}.txt"), "y\n");
    }

    let capped = repo.open_with(Arc::new(CappedHost(4096)));
    let changes = capped.working_changes(&base).unwrap();
    assert_eq!(changes.len(), 6);
    let mut squeezed = changes.clone();
    for change in &mut squeezed {
        change.stats = Some(LineStats::Text {
            additions: 1,
            deletions: 1,
        });
    }
    let spec = DiffSpec::WorkingTree { base };
    let patches = capped.patches(&spec, &squeezed).unwrap();
    let big = patches.iter().find(|p| p.path == "big.txt").unwrap();
    assert!(big.too_large && big.diff.is_none());
    for patch in patches.iter().filter(|p| p.path != "big.txt") {
        assert!(!patch.too_large);
        assert_eq!(
            patch.diff.as_ref().unwrap().additions(),
            1,
            "{}",
            patch.path
        );
    }

    assert!(matches!(
        capped.read_at("HEAD", "big.txt").map(|_| ()),
        Ok(())
    ));
    repo.commit_all("big");
    assert!(matches!(
        capped.read_at("HEAD", "big.txt"),
        Err(GitError::TooLarge { .. })
    ));
}

#[test]
fn submodules_are_opaque() {
    let inner = TestRepo::new();
    inner.write("x", "1\n");
    let first = inner.commit_all("one");
    inner.write("x", "2\n");
    inner.commit_all("two");

    let repo = TestRepo::new();
    repo.git(&[
        "submodule",
        "add",
        "-q",
        inner.path.to_str().unwrap(),
        "vendor/inner",
    ]);
    let base = repo.commit_all("add submodule");
    let sub = repo.path.join("vendor/inner");
    TestRepo::git_in(&sub, &["checkout", "-q", &first]);
    std::fs::write(sub.join("dirty"), "untracked inside\n").unwrap();

    let opened = repo.open();
    let changes = opened.working_changes(&base).unwrap();
    assert_eq!(changes.len(), 1, "{changes:#?}");
    assert_eq!(changes[0].kind(), FileKind::Submodule);
    let patch = opened
        .patch(&DiffSpec::WorkingTree { base }, &changes[0])
        .unwrap();
    let lines = &patch.diff.unwrap().hunks[0].lines;
    assert!(lines[0].text.starts_with("Subproject commit "));
}

#[test]
fn stores_worktree_blobs_and_counts_each_commit() {
    let repo = TestRepo::new();
    repo.write("a.txt", "a\n");
    let root = repo.commit_all("root");
    repo.write("a.txt", "a\nb\nc\n");
    repo.write("n.txt", "new\n");
    let tip = repo.commit_all("two files");
    repo.write("a.txt", "uncommitted\n");

    let opened = repo.open();
    let hashed = opened.working_changes("HEAD").unwrap()[0]
        .new_oid
        .clone()
        .unwrap();
    assert!(opened.existing_objects(&[&hashed]).unwrap().is_empty());
    let stored = opened.store_worktree_blobs(&["a.txt"]).unwrap();
    assert_eq!(stored, [hashed.clone()]);
    assert_eq!(opened.read_blob(&hashed).unwrap(), b"uncommitted\n");
    let present = opened.existing_objects(&[&hashed, "0123456789"]).unwrap();
    assert_eq!(present.len(), 1);

    let stats = opened.commit_stats(&root, "HEAD").unwrap();
    assert_eq!(stats.len(), 1);
    let tip_stats = stats[&tip];
    assert_eq!(
        (tip_stats.files, tip_stats.additions, tip_stats.deletions),
        (2, 3, 0)
    );
}
