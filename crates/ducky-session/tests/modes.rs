mod support;

use ducky_review::checklist::{ChecklistDraft, ChecklistScope};
use ducky_review::commit_range::CommitRange;
use ducky_review::last_look::SinceKind;
use ducky_review::view_notes::{NoteView, ShownLines, place_notes};
use ducky_review::{ChangeStatus, NumberedLine, Severity, Side};
use ducky_session::{
    DiffOptions, ExportFormat, NotEditable, NoteDraft, Review, ReviewMode, SaveOutcome,
    SessionError, SideSource, export_checklists, open_for_edit, save_edit,
};
use support::{Fixture, numbered};

/// main: a.rs, b.rs, gone.rs. feature: one commit editing all three.
fn feature() -> Fixture {
    let repo = Fixture::new();
    repo.write("a.rs", numbered("a", 20));
    repo.write("b.rs", numbered("b", 20));
    repo.write("gone.rs", numbered("gone", 5));
    repo.commit("base");
    repo.git(&["checkout", "-q", "-b", "feature"]);
    repo.write(
        "a.rs",
        numbered("a", 20).replace("a line 3\n", "a line three\n"),
    );
    repo.write(
        "b.rs",
        numbered("b", 20).replace("b line 4\n", "b line four\n"),
    );
    repo.write("gone.rs", numbered("gone", 6));
    repo.commit("first pass");
    repo
}

fn view_all(review: &Review) -> Review {
    for file in &review.files {
        review.notes_service().mark_viewed(file, true).unwrap();
    }
    review.refresh().unwrap()
}

fn kinds(review: &Review) -> Vec<(String, SinceKind)> {
    let since = review.since.as_ref().expect("a last look");
    since
        .entries
        .iter()
        .map(|entry| (entry.original.path.clone(), entry.kind))
        .collect()
}

fn diff_text(review: &Review, mode: &ReviewMode, path: &str) -> Vec<String> {
    let view = review.view(mode).unwrap();
    let diff = review
        .load_entry_diff(view.entry(path).unwrap(), DiffOptions::default())
        .unwrap();
    diff.text()
        .unwrap()
        .lines
        .iter()
        .filter(|line| line.kind != ducky_review::diff::LineKind::Context)
        .map(|line| line.text.clone())
        .collect()
}

#[test]
fn classifies_files_since_the_last_look_after_new_commits() {
    let repo = feature();
    let review = repo.open();
    assert!(review.since.is_none());
    let looked = view_all(&review);
    assert!(
        kinds(&looked)
            .iter()
            .all(|(_, k)| *k == SinceKind::Unchanged)
    );
    let head_then = looked.head.sha.clone().unwrap();

    repo.write(
        "a.rs",
        numbered("a", 20).replace("a line 3\n", "a line 3!\n"),
    );
    repo.write("c.rs", "new file\n");
    repo.commit("second pass");
    let review = looked.refresh().unwrap();
    assert_eq!(
        kinds(&review),
        [
            ("a.rs".into(), SinceKind::Changed),
            ("b.rs".into(), SinceKind::Unchanged),
            ("c.rs".into(), SinceKind::New),
            ("gone.rs".into(), SinceKind::Unchanged),
        ]
    );
    let moved = review.since.as_ref().unwrap().head_moved.clone().unwrap();
    assert_eq!(
        (moved.from, moved.commits, moved.rewritten),
        (head_then, Some(1), false)
    );

    assert_eq!(
        diff_text(&review, &ReviewMode::Since, "a.rs"),
        ["a line three", "a line 3!"]
    );
    assert_eq!(
        diff_text(&review, &ReviewMode::All, "a.rs"),
        ["a line 3", "a line 3!"]
    );
    let since = review.view(&ReviewMode::Since).unwrap();
    assert_eq!(since.entry("a.rs").unwrap().note_view, NoteView::Interdiff);
    assert_eq!(since.entry("c.rs").unwrap().note_view, NoteView::All);
}

#[test]
fn compares_by_content_after_an_amend_and_survives_uncommitted_looks() {
    let repo = feature();
    repo.write(
        "b.rs",
        numbered("b", 20).replace("b line 4\n", "b line four, uncommitted\n"),
    );
    let looked = view_all(&repo.open());
    repo.write(
        "b.rs",
        numbered("b", 20).replace("b line 4\n", "b line 4 again\n"),
    );
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "--amend", "-m", "first pass, amended"]);
    let review = looked.refresh().unwrap();
    let moved = review.since.as_ref().unwrap().head_moved.clone().unwrap();
    assert!(moved.rewritten);
    assert_eq!(moved.commits, None);
    let kinds = kinds(&review);
    assert!(kinds.contains(&("a.rs".into(), SinceKind::Unchanged)));
    assert!(kinds.contains(&("b.rs".into(), SinceKind::Changed)));
    assert_eq!(
        diff_text(&review, &ReviewMode::Since, "b.rs"),
        ["b line four, uncommitted", "b line 4 again"]
    );
}

#[test]
fn a_file_deleted_since_and_a_reviewed_version_that_is_gone() {
    let repo = feature();
    let looked = view_all(&repo.open());
    std::fs::remove_file(repo.path.join("a.rs")).unwrap();
    let state_path = repo.notes_file("feature").with_file_name("state.json");
    let state = std::fs::read_to_string(&state_path).unwrap();
    let b_oid = looked.files[1].change.new_oid.clone().unwrap();
    std::fs::write(
        &state_path,
        state.replace(b_oid.as_str(), "0123456789abcdef0123456789abcdef01234567"),
    )
    .unwrap();
    repo.write("b.rs", "rewritten\n");

    let review = looked.refresh().unwrap();
    let kinds = kinds(&review);
    assert!(kinds.contains(&("a.rs".into(), SinceKind::Changed)));
    assert!(kinds.contains(&("b.rs".into(), SinceKind::Missing)));
    let view = review.view(&ReviewMode::Since).unwrap();
    let a = view.entry("a.rs").unwrap();
    assert_eq!(a.new, SideSource::Absent);
    let b = view.entry("b.rs").unwrap();
    assert_eq!(b.old, SideSource::Rev(review.merge_base.clone()));
    assert_eq!(b.note_view, NoteView::All);
    assert!(diff_text(&review, &ReviewMode::Since, "a.rs").len() > 10);
}

/// feature: three commits, each touching one file.
fn commits() -> Fixture {
    let repo = Fixture::new();
    repo.write("a.rs", numbered("a", 10));
    repo.commit("base");
    repo.git(&["checkout", "-q", "-b", "feature"]);
    repo.write(
        "a.rs",
        numbered("a", 10).replace("a line 2\n", "a line two\n"),
    );
    repo.commit("Edit a");
    repo.write("b.rs", numbered("b", 4));
    repo.commit("Add b");
    let both = numbered("a", 10)
        .replace("a line 2\n", "a line two\n")
        .replace("a line 9\n", "a line nine\n");
    repo.write("a.rs", both);
    repo.commit("Edit a again");
    repo
}

#[test]
fn selects_one_commit_or_a_range_and_notices_when_it_is_gone() {
    let repo = commits();
    let review = repo.open();
    assert_eq!(review.commits.len(), 3);
    let stats = &review.commit_stats[&review.commits[1].sha];
    assert_eq!((stats.files, stats.additions), (1, 4));

    let single = ReviewMode::commits(CommitRange::single(1), &review.commits).unwrap();
    let view = review.view(&single).unwrap();
    let paths: Vec<&str> = view.entries.iter().map(|e| e.file.path()).collect();
    assert_eq!(paths, ["b.rs"]);
    assert_eq!(
        view.commit.as_ref().unwrap().label,
        format!("{} Add b", &review.commits[1].sha[..7])
    );
    let b = &view.entries[0];
    assert_eq!(b.old, SideSource::Absent);
    assert_eq!(b.new, SideSource::Rev(review.commits[1].sha.clone()));
    assert!(b.in_final && !b.shows_worktree);

    let range = ReviewMode::commits(CommitRange { from: 0, to: 2 }, &review.commits).unwrap();
    let view = review.view(&range).unwrap();
    assert_eq!(view.entries.len(), 2);
    assert_eq!(
        view.commit.as_ref().unwrap().base,
        Some(review.merge_base.clone())
    );
    assert_eq!(diff_text(&review, &range, "a.rs").len(), 4);
    let first = ReviewMode::commits(CommitRange::single(0), &review.commits).unwrap();
    assert_eq!(
        diff_text(&review, &first, "a.rs"),
        ["a line 2", "a line two"]
    );

    repo.git(&["commit", "-q", "--amend", "-m", "Edit a again, reworded"]);
    let review = review.refresh().unwrap();
    let gone = ReviewMode::Commits {
        from: review.commits[0].sha.clone(),
        to: "0000000000000000000000000000000000000000".into(),
    };
    assert!(matches!(review.view(&gone), Err(SessionError::CommitsGone)));
}

fn lines(review: &Review, mode: &ReviewMode, path: &str) -> Vec<NumberedLine> {
    let view = review.view(mode).unwrap();
    let diff = review
        .load_entry_diff(view.entry(path).unwrap(), DiffOptions::default())
        .unwrap();
    diff.side_lines(Side::New).unwrap().to_vec()
}

fn draft(path: &str, line: u32, body: &str) -> NoteDraft {
    NoteDraft {
        path: path.into(),
        side: Side::New,
        line,
        end_line: None,
        body: body.into(),
        severity: Severity::Issue,
    }
}

#[test]
fn places_notes_per_view_and_pins_notes_on_lines_gone_later() {
    let repo = commits();
    let review = repo.open();
    let first = ReviewMode::commits(CommitRange::single(0), &review.commits).unwrap();
    let first_sha = review.commits[0].sha.clone();
    let shown = lines(&review, &first, "a.rs");
    let shown = ShownLines {
        old: None,
        new: Some(&shown),
    };
    let service = review.notes_service();
    let kept = service
        .add_in_view(
            draft("a.rs", 2, "still here"),
            &NoteView::Commit {
                sha: first_sha.clone(),
            },
            shown,
        )
        .unwrap();
    assert_eq!(kept.commit, None);
    let pinned = service
        .add_in_view(
            draft("a.rs", 9, "gone later"),
            &NoteView::Commit {
                sha: first_sha.clone(),
            },
            shown,
        )
        .unwrap();
    assert_eq!(pinned.commit.as_deref(), Some(first_sha.as_str()));
    assert_eq!(pinned.anchor.code, ["a line 9"]);

    let base_side = service.add_in_view(
        NoteDraft {
            side: Side::Old,
            ..draft("a.rs", 2, "base")
        },
        &NoteView::Commit {
            sha: first_sha.clone(),
        },
        ShownLines {
            old: shown.new,
            new: shown.new,
        },
    );
    assert!(matches!(base_side, Err(SessionError::ViewAnchor(_))));

    let review = review.refresh().unwrap();
    let notes: Vec<_> = review.notes_on("a.rs").cloned().collect();
    let all = place_notes(&notes, None, &NoteView::All);
    assert_eq!(all.placed.len(), 1);
    assert_eq!(all.elsewhere.len(), 1);
    let commit_lines = lines(&review, &first, "a.rs");
    let on_commit = place_notes(
        &notes,
        Some(&commit_lines),
        &NoteView::Commit { sha: first_sha },
    );
    assert_eq!(on_commit.placed.len(), 2);
    let interdiff = place_notes(&notes, None, &NoteView::Interdiff);
    assert_eq!(interdiff.placed.len(), 1);
    assert_eq!(interdiff.placed[0].body, "still here");
}

#[test]
fn keeps_repo_and_global_checklists_and_ticks_per_review() {
    let repo = commits();
    let review = repo.open();
    let global_dir = tempfile::tempdir().unwrap();
    let store = review.checklist_store(Some(global_dir.path().to_str().unwrap().to_owned()));
    let repo_list = store
        .create(
            ChecklistScope::Repo,
            ChecklistDraft {
                title: "Before push".into(),
                items: vec!["Tests pass".into(), "No debug logs".into()],
                required: true,
            },
        )
        .unwrap();
    let added = store
        .import(
            ChecklistScope::Global,
            "habits.md",
            "# Habits\n\n- [ ] Read the tests\n",
        )
        .unwrap();
    assert_eq!(added, 1);
    let lists = store.load().unwrap();
    assert_eq!((lists.global.len(), lists.repo.len()), (1, 1));
    assert_eq!(lists.applicable()[0].0, ChecklistScope::Global);
    assert!(!global_dir.path().join("README.md").exists());

    let state = review
        .notes_service()
        .set_checked(&repo_list.items[0].id, true)
        .unwrap();
    let progress = lists.progress(&state);
    assert_eq!(
        (progress.ticked, progress.total, progress.required_open),
        (1, 3, 1)
    );
    let review = review.refresh().unwrap();
    assert!(review.state.is_checked(&repo_list.items[0].id));

    let mut edited = repo_list.clone();
    edited.title = "Before merge".into();
    edited.items.pop();
    store.save(ChecklistScope::Repo, edited).unwrap();
    let lists = store.load().unwrap();
    assert_eq!(lists.repo[0].items.len(), 1);
    let json = export_checklists(&[&lists.repo[0]], ExportFormat::Json);
    assert!(json.contains("\"required\": true"));
    assert!(export_checklists(&[&lists.global[0]], ExportFormat::Markdown).starts_with("# Habits"));
    store
        .delete(ChecklistScope::Repo, &lists.repo[0].id)
        .unwrap();
    assert!(store.load().unwrap().repo.is_empty());
    assert!(store.import(ChecklistScope::Repo, "x.json", "{}").is_err());
}

#[test]
fn saves_edits_guarding_against_changes_on_disk_and_reanchors_notes() {
    let repo = commits();
    let review = repo.open();
    let all = review.view(&ReviewMode::All).unwrap();
    let entry = all.entry("a.rs").unwrap();
    let buffer = open_for_edit(review.repo().unwrap(), entry)
        .unwrap()
        .unwrap();
    assert!(buffer.text.starts_with("a line 1\na line two\n"));

    let shown = lines(&review, &ReviewMode::All, "a.rs");
    review
        .notes_service()
        .add_in_view(
            draft("a.rs", 9, "on nine"),
            &NoteView::All,
            ShownLines {
                old: None,
                new: Some(&shown),
            },
        )
        .unwrap();

    let edited = format!("// header\n{}", buffer.text);
    let saved = match save_edit(review.repo().unwrap(), &buffer, &edited, false).unwrap() {
        SaveOutcome::Saved(saved) => saved,
        other => panic!("{other:?}"),
    };
    assert_eq!(
        std::fs::read_to_string(repo.path.join("a.rs")).unwrap(),
        edited
    );
    let review = review.refresh().unwrap();
    let note = review.notes_on("a.rs").next().unwrap();
    assert_eq!(note.anchor.line, 10);

    repo.write("a.rs", "someone else\n");
    assert_eq!(
        save_edit(review.repo().unwrap(), &saved, "mine\n", false).unwrap(),
        SaveOutcome::Conflict { deleted: false }
    );
    assert_eq!(
        std::fs::read_to_string(repo.path.join("a.rs")).unwrap(),
        "someone else\n"
    );
    assert!(matches!(
        save_edit(review.repo().unwrap(), &saved, "mine\n", true).unwrap(),
        SaveOutcome::Saved(_)
    ));
    std::fs::remove_file(repo.path.join("a.rs")).unwrap();
    assert_eq!(
        save_edit(review.repo().unwrap(), &saved, "x\n", false).unwrap(),
        SaveOutcome::Conflict { deleted: true }
    );

    let commit = ReviewMode::commits(CommitRange::single(1), &review.commits).unwrap();
    let view = review.view(&commit).unwrap();
    assert_eq!(
        open_for_edit(review.repo().unwrap(), &view.entries[0]).unwrap(),
        Err(NotEditable::Historical)
    );
    repo.git(&["rm", "-q", "b.rs"]);
    let review = review.refresh().unwrap();
    let all = review.view(&ReviewMode::All).unwrap();
    let b = all.entry("b.rs");
    assert!(b.is_none_or(|b| b.file.change.status == ChangeStatus::Deleted));
}
