//! Pull request reviews against the fake GitHub world: opening without a checkout, threads,
//! pushing notes and linking them, submitting, CI annotations, a moved head, carrying a branch's
//! notes over. Nothing here talks to github.com.

mod support;

use std::collections::HashSet;
use std::sync::Arc;

use ducky_github::ReviewEvent;
use ducky_github::ci::{CiState, poll_delay};
use ducky_github::fake::{FakeWorld, WorldOptions, Write};
use ducky_github::review::{PushSelection, SubmitInput, needs_body};
use ducky_github::reviewers::ReviewerState;
use ducky_host::LocalHost;
use ducky_review::{Severity, Side};
use ducky_session::pull::{
    Checkout, CheckoutRequest, PullOpen, carry_branch_notes, current_head, file_annotations,
    file_threads, load_activity, load_ci, open_pull, push_notes, push_preview, reply_to_thread,
    set_thread_resolved, submit_review,
};
use ducky_session::{DiffContent, DiffOptions, NoteDraft, Review, ReviewMode, ReviewRequest};
use support::Fixture;

struct Setup {
    world: FakeWorld,
    _notes: tempfile::TempDir,
    open: PullOpen,
}

fn setup() -> Setup {
    let world = FakeWorld::start(WorldOptions::default());
    let notes = tempfile::tempdir().unwrap();
    let open = PullOpen {
        repo: FakeWorld::repo(),
        number: 7,
        checkout: None,
        notes_dir: notes.path().to_str().unwrap().to_owned(),
        local: Arc::new(LocalHost),
    };
    Setup {
        world,
        _notes: notes,
        open,
    }
}

impl Setup {
    fn open(&self) -> Review {
        open_pull(&self.world.client(), self.open.clone()).unwrap()
    }
}

fn line_of(text: &str, needle: &str) -> u32 {
    text.lines().position(|l| l.contains(needle)).unwrap() as u32 + 1
}

fn note(review: &Review, path: &str, line: u32, body: &str) {
    let diff = review.load_diff(path, DiffOptions::default()).unwrap();
    let lines = diff.side_lines(Side::New).unwrap().to_vec();
    let draft = NoteDraft {
        path: path.into(),
        side: Side::New,
        line,
        end_line: None,
        body: body.into(),
        severity: Severity::Issue,
    };
    review.notes_service().add(draft, &lines).unwrap();
}

#[test]
fn opens_a_pull_request_from_github_alone() {
    let setup = setup();
    let review = setup.open();
    let pull = review.pull.as_ref().unwrap();
    assert_eq!(pull.checkout, Checkout::None);
    assert!(review.repo().is_none());
    assert_eq!(review.toplevel(), "github.com/acme/widgets");
    assert_eq!(review.branch_label(), "#7 feature/parser");
    assert_eq!(review.merge_base, setup.world.merge_base_sha());
    let paths: Vec<&str> = review.files.iter().map(|f| f.path()).collect();
    assert_eq!(
        paths,
        [
            "README.md",
            "docs/old.md",
            "logo.png",
            "src/lib.rs",
            "src/parse.rs"
        ]
    );
    assert_eq!(review.commits.len(), 2);

    let lib = review
        .load_diff("src/lib.rs", DiffOptions::default())
        .unwrap();
    let text = lib.text().unwrap();
    assert_eq!(
        text.new_text.as_deref(),
        setup.world.head_text("src/lib.rs").as_deref()
    );
    assert!(
        text.old_text
            .as_deref()
            .unwrap()
            .contains("let mut sum = 0;")
    );
    let logo = review
        .load_diff("logo.png", DiffOptions::default())
        .unwrap();
    assert!(matches!(logo.content, DiffContent::Binary { .. }));
    let gone = review
        .load_diff("docs/old.md", DiffOptions::default())
        .unwrap();
    assert!(gone.text().unwrap().new_text.is_none());

    let view = review.view(&ReviewMode::All).unwrap();
    let entry = view.entry("src/lib.rs").unwrap();
    assert_eq!(
        ducky_session::editable(entry).unwrap_err(),
        ducky_session::NotEditable::NoCheckout
    );
    let first = review
        .view(&ReviewMode::Commits {
            from: review.commits[0].sha.clone(),
            to: review.commits[0].sha.clone(),
        })
        .unwrap();
    let in_first: Vec<&str> = first.entries.iter().map(|e| e.file.path()).collect();
    assert_eq!(in_first, ["src/lib.rs", "src/parse.rs"]);
    let diff = review
        .load_entry_diff(first.entry("src/lib.rs").unwrap(), DiffOptions::default())
        .unwrap();
    assert!(
        !diff
            .text()
            .unwrap()
            .new_text
            .as_deref()
            .unwrap()
            .contains("discounted")
    );
    assert!(setup.world.writes().is_empty());
}

#[test]
fn places_threads_and_reads_reviewers() {
    let setup = setup();
    let review = setup.open();
    let pull = review.pull.as_ref().unwrap();
    let activity = load_activity(pull).unwrap();
    assert_eq!(activity.threads.viewer, "duckreviewer");

    let lib = setup.world.head_text("src/lib.rs").unwrap();
    let placed = file_threads(&activity.threads.threads, "src/lib.rs");
    let lines: Vec<(Side, u32)> = placed.by_line.keys().copied().collect();
    assert_eq!(
        lines,
        [
            (Side::New, line_of(&lib, ".sum()")),
            (Side::New, line_of(&lib, "(100 - percent)"))
        ]
    );
    let outdated = file_threads(&activity.threads.threads, "src/parse.rs");
    assert!(outdated.by_line.is_empty());
    assert!(outdated.listed[0].is_outdated);
    assert!(file_threads(&activity.threads.threads, "README.md").listed[0].file_level);

    let states: Vec<(&str, ReviewerState)> = activity
        .reviewers
        .iter()
        .map(|r| (r.login.as_str(), r.state))
        .collect();
    assert!(states.contains(&("dave", ReviewerState::Approved)));
    assert!(states.contains(&("duckreviewer", ReviewerState::Requested)));
}

#[test]
fn replies_and_resolves_threads() {
    let setup = setup();
    let review = setup.open();
    let pull = review.pull.as_ref().unwrap();
    let reply = reply_to_thread(pull, "PRRT_discount", "Clamped in the next push?").unwrap();
    assert_eq!(reply.author, "duckreviewer");
    assert_eq!(setup.world.thread_comment_count("PRRT_discount"), Some(3));
    assert!(set_thread_resolved(pull, "PRRT_discount", true).unwrap());
    assert_eq!(setup.world.thread_resolved("PRRT_discount"), Some(true));
    assert!(!set_thread_resolved(pull, "PRRT_discount", false).unwrap());
    assert_eq!(setup.world.writes().len(), 3);
}

#[test]
fn pushes_notes_into_a_pending_review_and_links_them() {
    let setup = setup();
    let review = setup.open();
    let lib = setup.world.head_text("src/lib.rs").unwrap();
    note(
        &review,
        "src/lib.rs",
        line_of(&lib, "let plural"),
        "Use a helper for plurals",
    );
    note(
        &review,
        "src/lib.rs",
        line_of(&lib, "pub struct Item"),
        "Derive Debug",
    );
    let review = review.refresh().unwrap();

    let preview = push_preview(&review).unwrap();
    assert_eq!(preview.placement.placed.len(), 1);
    assert_eq!(preview.placement.unplaced.len(), 1);
    assert_eq!(
        preview.placement.unplaced[0].reason,
        "Line is not in the pull request diff"
    );

    let selection = PushSelection::from(preview.placement.clone());
    let pushed = push_notes(&review, None, &selection).unwrap();
    assert_eq!(pushed.linked, 1);
    assert!(setup.world.has_pending_review());
    assert!(matches!(
        &setup.world.writes()[0],
        Write::CreateReview { event: None, comments: 1, body } if body.contains("Derive Debug")
    ));

    let review = review.refresh().unwrap();
    let linked: Vec<_> = review
        .notes
        .iter()
        .filter_map(|n| n.github.clone())
        .collect();
    assert_eq!(linked.len(), 2);
    assert!(linked.iter().all(|g| g.review_id == Some(pushed.review.id)));
    assert_eq!(linked.iter().filter(|g| g.comment_id.is_some()).count(), 1);
    assert!(push_preview(&review).unwrap().placement.placed.is_empty());

    note(&review, "src/parse.rs", 3, "Name the error case");
    let review = review.refresh().unwrap();
    let pending = load_activity(review.pull.as_ref().unwrap())
        .unwrap()
        .threads
        .pending_review
        .unwrap();
    let preview = push_preview(&review).unwrap();
    assert_eq!(preview.placement.placed.len(), 1);
    let more = push_notes(&review, Some(&pending), &preview.placement.into()).unwrap();
    assert_eq!(more.linked, 1);
    assert!(matches!(
        setup.world.writes().last(),
        Some(Write::AddThread { path, .. }) if path == "src/parse.rs"
    ));
    assert_eq!(setup.world.pending_comment_count(), 2);
}

#[test]
fn submits_the_pending_review() {
    let setup = setup();
    let review = setup.open();
    let lib = setup.world.head_text("src/lib.rs").unwrap();
    note(
        &review,
        "src/lib.rs",
        line_of(&lib, "let count"),
        "Inline this",
    );
    let review = review.refresh().unwrap();
    let selection = PushSelection::from(push_preview(&review).unwrap().placement);
    push_notes(&review, None, &selection).unwrap();
    let review = review.refresh().unwrap();
    let pending = load_activity(review.pull.as_ref().unwrap())
        .unwrap()
        .threads
        .pending_review;

    let input = SubmitInput {
        event: ReviewEvent::RequestChanges,
        body: String::new(),
        placement: None,
    };
    assert!(!needs_body(
        &input,
        pending.as_ref().map_or(0, |p| p.comments as usize)
    ));
    let empty_comment = SubmitInput {
        event: ReviewEvent::Comment,
        ..input.clone()
    };
    assert!(needs_body(&empty_comment, 0));

    let result = submit_review(&review, pending.as_ref(), &input).unwrap();
    assert_eq!(result.state, "CHANGES_REQUESTED");
    assert!(!setup.world.has_pending_review());
    assert!(matches!(
        setup.world.writes().last(),
        Some(Write::SubmitReview { event, .. }) if event == "REQUEST_CHANGES"
    ));
    let review = review.refresh().unwrap();
    assert!(review.state.last_review.is_some());
}

#[test]
fn reads_ci_and_places_annotations_inline() {
    let setup = setup();
    let review = setup.open();
    let pull = review.pull.as_ref().unwrap();
    let ci = load_ci(pull).unwrap().unwrap();
    let summary = ci.summary();
    assert_eq!(summary.state, CiState::Fail);
    assert_eq!((summary.failed, summary.pending), (1, 1));

    let paths: HashSet<&str> = review.files.iter().map(|f| f.path()).collect();
    let lib = setup.world.head_text("src/lib.rs").unwrap();
    let placed = file_annotations(&ci, &paths, "src/lib.rs", Some(lib.lines().count() as u32));
    assert_eq!(
        placed.by_line.keys().copied().collect::<Vec<_>>(),
        [line_of(&lib, "(100 - percent)")]
    );
    let grouped = ducky_github::ci::group_annotations(&ci.annotations, &paths);
    assert_eq!(grouped.elsewhere[0].path, "build.rs");

    let mut attempt = 0;
    let settled = loop {
        let ci = load_ci(pull).unwrap().unwrap();
        if ci.summary().pending == 0 {
            break ci;
        }
        assert!(poll_delay(attempt).as_secs() >= 10);
        attempt += 1;
        assert!(attempt < 5, "the pending run never finished");
    };
    assert_eq!(settled.summary().passed, 3);
}

#[test]
fn notices_a_moved_head_and_refreshes_onto_it() {
    let setup = setup();
    let review = setup.open();
    let pull = review.pull.as_ref().unwrap();
    assert_eq!(current_head(pull).unwrap(), pull.head_sha());

    let file = review
        .files
        .iter()
        .find(|f| f.path() == "src/parse.rs")
        .unwrap()
        .clone();
    review.notes_service().mark_viewed(&file, true).unwrap();
    let moved = setup.world.move_head();
    assert_eq!(current_head(pull).unwrap(), moved);

    let review = review.refresh().unwrap();
    assert_eq!(review.pull.as_ref().unwrap().head_sha(), moved);
    let since = review.since.as_ref().unwrap();
    assert_eq!(
        since.entry("src/parse.rs").unwrap().kind,
        ducky_review::last_look::SinceKind::Changed
    );
    let view = review.view(&ReviewMode::Since).unwrap();
    let diff = review
        .load_entry_diff(view.entry("src/parse.rs").unwrap(), DiffOptions::default())
        .unwrap();
    let (adds, dels) = diff.counts();
    assert_eq!((adds, dels), (2, 2), "only the new commit's change");
}

#[test]
fn carries_a_branch_s_notes_over_to_its_pull_request() {
    let setup = setup();
    let fixture = Fixture::new();
    fixture.write("a.txt", "one\n");
    fixture.commit("base");
    fixture.git(&["checkout", "-q", "-b", "feature/parser"]);
    fixture.write("src/lib.rs", setup.world.head_text("src/lib.rs").unwrap());
    fixture.commit("work");
    let branch = fixture.open();
    let lib = setup.world.head_text("src/lib.rs").unwrap();
    note(
        &branch,
        "src/lib.rs",
        line_of(&lib, "let plural"),
        "Plural helper",
    );
    let branch = branch.refresh().unwrap();

    let open = PullOpen {
        checkout: Some(CheckoutRequest {
            host: Arc::new(LocalHost),
            request: ReviewRequest::local(fixture.path.to_str().unwrap()),
        }),
        ..setup.open.clone()
    };
    let pull = open_pull(&setup.world.client(), open).unwrap();
    assert!(matches!(
        pull.pull.as_ref().unwrap().checkout,
        Checkout::Elsewhere { .. }
    ));
    assert_eq!(carry_branch_notes(&branch, &pull).unwrap(), 1);
    let pull = pull.refresh().unwrap();
    assert_eq!(pull.notes.len(), 1);
    assert_eq!(pull.notes[0].carried_from, Some(branch.notes[0].id.clone()));
    assert_eq!(carry_branch_notes(&branch, &pull).unwrap(), 0);
    assert_eq!(push_preview(&pull).unwrap().placement.placed.len(), 1);
}

#[test]
fn a_read_only_client_cannot_push() {
    let setup = setup();
    let client = setup.world.client().read_only();
    let review = open_pull(&client, setup.open.clone()).unwrap();
    let lib = setup.world.head_text("src/lib.rs").unwrap();
    note(&review, "src/lib.rs", line_of(&lib, "let plural"), "x");
    let review = review.refresh().unwrap();
    let selection = PushSelection::from(push_preview(&review).unwrap().placement);
    assert!(push_notes(&review, None, &selection).is_err());
    assert!(setup.world.writes().is_empty());
}
