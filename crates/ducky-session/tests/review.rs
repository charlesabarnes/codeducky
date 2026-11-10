mod support;

use ducky_review::{NoteStatus, Severity, Side};
use ducky_session::{DiffContent, DiffOptions, FileNotice, NoteDraft};
use support::{Fixture, numbered};

/// main: lib.rs, old_name.rs, gone.txt. feature: lib.rs edited, old_name.rs renamed,
/// gone.txt deleted, a binary added, then an uncommitted new file.
fn branch_fixture() -> Fixture {
    let repo = Fixture::new();
    repo.write("src/lib.rs", numbered("lib", 30));
    repo.write("src/old_name.rs", numbered("renamed", 40));
    repo.write("gone.txt", "bye\n");
    repo.commit("base");
    repo.git(&["checkout", "-q", "-b", "feature"]);
    let lib = numbered("lib", 30).replace("lib line 10\n", "lib line ten\n");
    repo.write("src/lib.rs", lib);
    repo.git(&["mv", "src/old_name.rs", "src/new_name.rs"]);
    repo.git(&["rm", "-q", "gone.txt"]);
    repo.write("logo.png", [0x89, b'P', b'N', b'G', 0, 1, 2, 3]);
    repo.commit("feature work");
    repo.write("notes/todo.md", "# Todo\n");
    repo
}

#[test]
fn opens_a_branch_against_its_default_base() {
    let repo = branch_fixture();
    let review = repo.open();
    assert_eq!(review.branch_label(), "feature");
    assert_eq!(review.base, "main");
    assert_eq!(review.commits.len(), 1);
    let summary: Vec<(&str, &str)> = review
        .files
        .iter()
        .map(|file| (file.path(), file.badge().letter()))
        .collect();
    assert_eq!(
        summary,
        [
            ("gone.txt", "D"),
            ("logo.png", "A"),
            ("notes/todo.md", "A"),
            ("src/lib.rs", "M"),
            ("src/new_name.rs", "R"),
        ]
    );
    assert!(review.notes.is_empty());
    assert!(review.notes_problem.is_none());
}

#[test]
fn loads_text_binary_and_rename_diffs() {
    let repo = branch_fixture();
    let review = repo.open();

    let lib = review
        .load_diff("src/lib.rs", DiffOptions::default())
        .unwrap();
    assert_eq!(lib.counts(), (1, 1));
    assert!(lib.side_lines(Side::Old).is_some());

    let logo = review
        .load_diff("logo.png", DiffOptions::default())
        .unwrap();
    assert!(matches!(
        logo.content,
        DiffContent::Binary {
            old_size: None,
            new_size: Some(8)
        }
    ));

    let renamed = review
        .load_diff("src/new_name.rs", DiffOptions::default())
        .unwrap();
    assert!(renamed.notices.contains(&FileNotice::Renamed {
        from: "src/old_name.rs".into(),
        similarity: Some(100),
    }));
    assert!(renamed.notices.contains(&FileNotice::NoContentChange));

    let gone = review
        .load_diff("gone.txt", DiffOptions::default())
        .unwrap();
    assert_eq!(gone.counts(), (0, 1));
    assert!(gone.side_lines(Side::New).is_none());

    let todo = review
        .load_diff("notes/todo.md", DiffOptions::default())
        .unwrap();
    assert!(todo.notices.contains(&FileNotice::Untracked));
}

#[test]
fn ignores_whitespace_and_reports_line_endings_and_moves() {
    let repo = Fixture::new();
    let block: String = (1..=6)
        .map(|i| format!("    let value_{i} = compute({i});\n"))
        .collect();
    let filler = numbered("filler", 20);
    repo.write("a.rs", format!("{block}{filler}"));
    repo.write("crlf.txt", "one\ntwo\n");
    repo.commit("base");
    repo.git(&["checkout", "-q", "-b", "topic"]);
    repo.write("a.rs", format!("{filler}{block}"));
    repo.write("crlf.txt", "one\r\ntwo\r\n");
    repo.commit("move");
    repo.write(
        "a.rs",
        format!(
            "{}{block}",
            filler.replace("filler line 3", "filler  line 3")
        ),
    );
    let review = repo.open();

    let moved = review.load_diff("a.rs", DiffOptions::default()).unwrap();
    let text = moved.text().unwrap();
    assert_eq!(text.moved.len(), 2, "{:?}", text.moved);

    let ignoring = review
        .load_diff(
            "a.rs",
            DiffOptions {
                ignore_whitespace: true,
            },
        )
        .unwrap();
    assert!(ignoring.counts().0 < moved.counts().0);

    let crlf = review
        .load_diff("crlf.txt", DiffOptions::default())
        .unwrap();
    assert!(
        crlf.notices
            .iter()
            .any(|n| matches!(n, FileNotice::LineEndings(c) if c.only))
    );
}

#[test]
fn notes_round_trip_and_follow_edits() {
    let repo = branch_fixture();
    let review = repo.open();
    let diff = review
        .load_diff("src/lib.rs", DiffOptions::default())
        .unwrap();
    let service = review.notes_service();
    let note = service
        .add(
            NoteDraft {
                path: "src/lib.rs".into(),
                side: Side::New,
                line: 10,
                end_line: Some(12),
                body: "Why **ten**?".into(),
                severity: Severity::Issue,
            },
            diff.side_lines(Side::New).unwrap(),
        )
        .unwrap();
    assert_eq!(
        note.anchor.code,
        ["lib line ten", "lib line 11", "lib line 12"]
    );

    let mut lib = numbered("lib", 30).replace("lib line 10\n", "lib line ten\n");
    lib.insert_str(0, "// header\n// more\n");
    repo.write("src/lib.rs", lib);
    let review = review.refresh().unwrap();
    let moved = &review.notes[0];
    assert_eq!((moved.anchor.line, moved.anchor.end_line), (12, Some(14)));
    assert!(!moved.anchor_lost);

    repo.write("src/lib.rs", numbered("lib", 30));
    let review = review.refresh().unwrap();
    assert!(review.notes[0].possibly_resolved());

    let service = review.notes_service();
    service
        .edit(&note.id, "Never mind".into(), Severity::Nit)
        .unwrap();
    service.resolve(&note.id).unwrap();
    let mut review = review;
    review.reload_notes().unwrap();
    assert_eq!(review.notes[0].status, NoteStatus::Resolved);
    review.notes_service().reopen(&note.id).unwrap();
    review.notes_service().delete(&note.id).unwrap();
    review.reload_notes().unwrap();
    assert!(review.notes.is_empty());
}

#[test]
fn picks_up_notes_an_agent_wrote_by_hand() {
    let repo = branch_fixture();
    let mut review = repo.open();
    let path = repo.notes_file("feature");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        &path,
        r#"{"version": 1, "target": {"kind": "branch", "branch": "feature"}, "notes": [
            {"id": "a7pq2m", "status": "resolved", "path": "src/lib.rs",
             "anchor": {"line": 10}, "body": "Rename this",
             "author": {"kind": "agent", "name": "claude-code"},
             "resolution": {"by": {"kind": "agent", "name": "claude-code"}, "text": "Done."}}
        ]}"#,
    )
    .unwrap();
    review.reload_notes().unwrap();
    let note = &review.notes[0];
    assert_eq!(note.author.label(), "claude-code");
    assert_eq!(note.status, NoteStatus::Resolved);

    let review = review.refresh().unwrap();
    assert_eq!(review.notes[0].anchor.code, ["lib line ten"]);
}

#[test]
fn notes_follow_a_file_that_is_renamed_later() {
    let repo = Fixture::new();
    repo.write("a.rs", numbered("a", 10));
    repo.commit("base");
    repo.git(&["checkout", "-q", "-b", "topic"]);
    repo.write(
        "a.rs",
        numbered("a", 10).replace("a line 5\n", "a line five\n"),
    );
    repo.commit("edit");
    let review = repo.open();
    let diff = review.load_diff("a.rs", DiffOptions::default()).unwrap();
    review
        .notes_service()
        .add(
            NoteDraft {
                path: "a.rs".into(),
                side: Side::New,
                line: 5,
                end_line: None,
                body: "five".into(),
                severity: Severity::Suggestion,
            },
            diff.side_lines(Side::New).unwrap(),
        )
        .unwrap();

    repo.git(&["mv", "a.rs", "b.rs"]);
    repo.commit("rename");
    let review = review.refresh().unwrap();
    assert_eq!(review.files[0].path(), "b.rs");
    let note = &review.notes[0];
    assert_eq!(note.path, "b.rs");
    assert_eq!(note.anchor.line, 5);
    assert!(!note.anchor_lost);
}

#[test]
fn viewed_marks_hold_until_the_file_changes() {
    let repo = branch_fixture();
    let review = repo.open();
    let file = review
        .files
        .iter()
        .find(|f| f.path() == "src/lib.rs")
        .unwrap();
    review.notes_service().mark_viewed(file, true).unwrap();
    let review = review.refresh().unwrap();
    assert_eq!(review.viewed_count(), 1);
    repo.write("src/lib.rs", numbered("lib", 31));
    let review = review.refresh().unwrap();
    assert_eq!(review.viewed_count(), 0);
}

#[test]
fn a_chosen_base_overrides_the_default() {
    let repo = branch_fixture();
    let first = repo.git(&["rev-parse", "HEAD"]);
    repo.write("later.txt", "x\n");
    repo.commit("later");
    let review = repo.open().with_base(first).unwrap();
    let paths: Vec<&str> = review.files.iter().map(|f| f.path()).collect();
    assert_eq!(paths, ["later.txt", "notes/todo.md"]);
}
