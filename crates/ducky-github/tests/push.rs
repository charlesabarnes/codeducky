//! Notes to review comments: placement on the PR patch, the review body, and the push and
//! submit flows against a fake GitHub. Write paths are only ever exercised here.

mod support;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use ducky_github::placement::{
    comment_ids_by_note, pending_review_input, place_notes, review_body,
};
use ducky_github::review::{
    PushLookup, PushSelection, SubmitInput, needs_body, prepare_pr_push, prepare_push,
    push_pending_review, push_to_pending_review, review_summary, submit_body, submit_pr_review,
    unpushed_notes,
};
use ducky_github::threads::PendingReview;
use ducky_github::{FileStatus, PullFile, PullRequest, RepoRef, ReviewComment, ReviewEvent, Side};
use ducky_review::patch::patch_side_lines;
use ducky_review::{
    GithubComment, NewNote, Note, NoteId, NoteStatus, NumberedLine, Severity, Timestamp,
    create_anchor, number_lines,
};
use serde_json::json;
use support::{FakeGitHub, Reply, fixture, fixture_text};

const HEAD: &str = "118bade96cd67e73abb7a355f5fc5f6a846805b8";
const TLS: &str = "server/src/boot/tls.ts";

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn pr_files() -> Vec<PullFile> {
    fixture("pull-files.json")
        .as_array()
        .unwrap()
        .iter()
        .map(|f| PullFile {
            path: f["filename"].as_str().unwrap().into(),
            previous_path: None,
            status: serde_json::from_value(f["status"].clone()).unwrap(),
            patch: f["patch"].as_str().map(str::to_owned),
            sha: None,
            additions: 0,
            deletions: 0,
        })
        .collect()
}

fn tls_head() -> Vec<NumberedLine> {
    number_lines(&fixture_text("tls-head.ts.txt"))
}

fn tls_patch() -> String {
    pr_files()
        .into_iter()
        .find(|f| f.path == TLS)
        .unwrap()
        .patch
        .unwrap()
}

fn line_of(lines: &[NumberedLine], text: &str) -> u32 {
    lines
        .iter()
        .find(|l| l.text.starts_with(text))
        .unwrap()
        .line
}

fn note_on(path: &str, lines: &[NumberedLine], line: u32, side: Side, end: Option<u32>) -> Note {
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst).to_string();
    let anchor = create_anchor(lines, line, side, end).unwrap();
    NewNote::new(path, anchor, "Check this").into_note(NoteId::new(id), Timestamp(0))
}

fn note(path: &str, lines: &[NumberedLine], line: u32) -> Note {
    note_on(path, lines, line, Side::New, None)
}

fn with(mut note: Note, body: &str, severity: Severity) -> Note {
    note.body = body.into();
    note.severity = severity;
    note
}

fn no_renames() -> HashMap<String, String> {
    HashMap::new()
}

#[test]
fn places_a_note_on_an_added_line_on_the_right() {
    let head = tls_head();
    let line = line_of(&head, "export function dnsProvider");
    let n = note(TLS, &head, line);
    let placement = place_notes(std::slice::from_ref(&n), &pr_files(), &no_renames());
    assert!(placement.unplaced.is_empty());
    let placed = &placement.placed[0];
    assert!(placed.exact);
    assert_eq!(placed.note, n);
    assert_eq!(
        (
            placed.comment.path.as_str(),
            placed.comment.line,
            placed.comment.side,
            placed.comment.start_line
        ),
        (TLS, line, Side::New, None)
    );
    assert_eq!(placed.comment.body, "**issue:** Check this");
}

#[test]
fn re_anchors_notes_from_a_local_file_that_moved_on() {
    let head = tls_head();
    let texts: Vec<String> = ["// local 1", "// local 2", "// local 3"]
        .into_iter()
        .map(str::to_owned)
        .chain(head.iter().map(|l| l.text.clone()))
        .collect();
    let local = number_lines(&texts.join("\n"));
    let pr_line = line_of(&head, "  const acmeDnsUrl");
    let n = note(TLS, &local, pr_line + 3);
    let placement = place_notes(&[n], &pr_files(), &no_renames());
    assert_eq!(placement.placed[0].comment.line, pr_line);
    assert_eq!(placement.placed[0].comment.side, Side::New);
}

#[test]
fn maps_base_side_notes_onto_the_left() {
    let left = patch_side_lines(&tls_patch(), Side::Old);
    let removed = line_of(&left, "function dnsProvider");
    let n = note_on(TLS, &left, removed, Side::Old, None);
    let comment = &place_notes(&[n], &pr_files(), &no_renames()).placed[0].comment;
    assert_eq!((comment.line, comment.side), (removed, Side::Old));
}

#[test]
fn reports_notes_that_cannot_be_placed_with_a_reason() {
    let head = tls_head();
    let outside = note(
        TLS,
        &head,
        line_of(&head, "      return acmeCertificates(d);"),
    );
    let other_file = note("README.md", &number_lines("# Gangway\n"), 1);
    let binary = note("logo.png", &number_lines("x\n"), 1);
    let mut files = pr_files();
    files.push(PullFile::new("logo.png", FileStatus::Added, None));
    let placement = place_notes(&[outside, other_file, binary], &files, &no_renames());
    assert!(placement.placed.is_empty());
    let reasons: HashMap<&str, &str> = placement
        .unplaced
        .iter()
        .map(|u| (u.note.path.as_str(), u.reason.as_str()))
        .collect();
    assert_eq!(
        reasons["README.md"],
        "File is not changed in the pull request"
    );
    assert_eq!(
        reasons["logo.png"],
        "GitHub shows no diff for this file (binary or too large)"
    );
    assert_eq!(reasons[TLS], "Line is not in the pull request diff");
}

#[test]
fn places_a_range_as_a_multi_line_comment() {
    let head = tls_head();
    let start = line_of(&head, "export function dnsProvider");
    let n = note_on(TLS, &head, start, Side::New, Some(start + 2));
    let placement = place_notes(&[n], &pr_files(), &no_renames());
    assert!(placement.unplaced.is_empty());
    let placed = &placement.placed[0];
    assert!(placed.exact);
    let c = &placed.comment;
    assert_eq!(
        (c.start_line, c.start_side, c.line, c.side),
        (Some(start), Some(Side::New), start + 2, Side::New)
    );
    let sent = serde_json::to_value(c).unwrap();
    assert_eq!(sent["start_side"], "RIGHT");
    assert_eq!(sent["side"], "RIGHT");
}

#[test]
fn moves_both_ends_of_a_range_with_local_edits() {
    let head = tls_head();
    let start = line_of(&head, "export function dnsProvider");
    let texts: Vec<String> = ["// local 1", "// local 2"]
        .into_iter()
        .map(str::to_owned)
        .chain(head.iter().map(|l| l.text.clone()))
        .collect();
    let local = number_lines(&texts.join("\n"));
    let n = note_on(TLS, &local, start + 2, Side::New, Some(start + 4));
    let c = &place_notes(&[n], &pr_files(), &no_renames()).placed[0].comment;
    assert_eq!((c.start_line, c.line), (Some(start), start + 2));
}

#[test]
fn leaves_a_range_outside_one_hunk_for_the_body() {
    let head = tls_head();
    let start = line_of(&head, "export function dnsProvider");
    let outside = line_of(&head, "      return acmeCertificates(d);");
    let n = note_on(TLS, &head, outside, Side::New, Some(start));
    let placement = place_notes(std::slice::from_ref(&n), &pr_files(), &no_renames());
    assert!(placement.placed.is_empty());
    assert_eq!(
        placement.unplaced[0].reason,
        "Lines are not all in one hunk of the pull request diff"
    );
    assert!(review_body(&[n]).contains(&format!("`{TLS}`, lines {outside}–{start}:")));
}

#[test]
fn lists_unplaced_notes_in_the_body_with_fenced_excerpts() {
    let head = tls_head();
    let line = line_of(&head, "      return acmeCertificates(d);");
    let n = with(
        note(TLS, &head, line),
        "Is ```this``` right?\nSecond line",
        Severity::Nit,
    );
    let body = review_body(std::slice::from_ref(&n));
    let first: Vec<&str> = body.split('\n').take(6).collect();
    assert_eq!(
        first,
        [
            "Notes that do not map onto the diff:",
            "",
            &format!("- **nit** in `{TLS}`, line {line}:"),
            "",
            "  Is ```this``` right?",
            "  Second line",
        ]
    );
    assert!(body.contains(&format!("  > {line} |       return acmeCertificates(d);")));
    assert!(body.contains("\n  ```\n"));
    assert_eq!(review_body(&[]), "");
}

#[test]
fn builds_a_pending_review_against_the_pr_head() {
    let head = tls_head();
    let n = note(TLS, &head, line_of(&head, "export function dnsProvider"));
    let placement = place_notes(&[n], &pr_files(), &no_renames());
    let input = pending_review_input(HEAD, &placement.placed, &[]);
    assert_eq!(input.commit_id, HEAD);
    assert_eq!(input.body, "");
    assert_eq!(input.comments, [placement.placed[0].comment.clone()]);
    assert_eq!(input.event, None);
}

#[test]
fn pairs_created_comments_with_their_notes() {
    let head = tls_head();
    let a = note(TLS, &head, line_of(&head, "export function dnsProvider"));
    let b = with(
        note(TLS, &head, line_of(&head, "  const acmeDnsUrl")),
        "Other",
        Severity::Issue,
    );
    let placement = place_notes(&[a.clone(), b.clone()], &pr_files(), &no_renames());
    let mut comments: Vec<ReviewComment> = placement
        .placed
        .iter()
        .enumerate()
        .map(|(i, p)| ReviewComment {
            id: 500 + i as u64,
            path: p.comment.path.clone(),
            line: Some(p.comment.line),
            side: Some(p.comment.side),
            body: p.comment.body.clone(),
        })
        .collect();
    comments.reverse();
    let ids = comment_ids_by_note(&placement.placed, &comments);
    assert_eq!(ids, HashMap::from([(a.id, 500), (b.id, 501)]));
}

mod renames {
    use super::*;

    const OLD: &str = "export function total(items) {\n  return sum(items)\n}\n";
    const NEW: &str = "export function total(items) {\n  return sum(items, 0)\n}\n";
    const PATCH: &str = "@@ -1,3 +1,3 @@\n export function total(items) {\n-  return sum(items)\n+  return sum(items, 0)\n }";

    fn note_at(path: &str, side: Side, line: u32) -> Note {
        let text = if side == Side::Old { OLD } else { NEW };
        note_on(path, &number_lines(text), line, side, None)
    }

    fn renamed() -> PullFile {
        PullFile {
            previous_path: Some("src/sum.ts".into()),
            ..PullFile::new("src/totals.ts", FileStatus::Renamed, Some(PATCH))
        }
    }

    #[test]
    fn places_a_note_left_on_the_old_name_on_the_renamed_file() {
        let placement = place_notes(
            &[note_at("src/sum.ts", Side::Old, 2)],
            &[renamed()],
            &no_renames(),
        );
        assert!(placement.unplaced.is_empty());
        let c = &placement.placed[0].comment;
        assert_eq!(
            (c.path.as_str(), c.line, c.side),
            ("src/totals.ts", 2, Side::Old)
        );
    }

    #[test]
    fn places_notes_on_the_new_name_on_both_sides() {
        let notes = [
            note_at("src/totals.ts", Side::New, 2),
            note_at("src/totals.ts", Side::Old, 2),
        ];
        let placement = place_notes(&notes, &[renamed()], &no_renames());
        let sides: Vec<(Side, u32)> = placement
            .placed
            .iter()
            .map(|p| (p.comment.side, p.comment.line))
            .collect();
        assert_eq!(sides, [(Side::New, 2), (Side::Old, 2)]);
    }

    #[test]
    fn sends_base_side_notes_to_the_deleted_path_when_github_did_not_pair_the_rename() {
        let files = [
            PullFile::new(
                "src/sum.ts",
                FileStatus::Removed,
                Some("@@ -1,3 +0,0 @@\n-export function total(items) {\n-  return sum(items)\n-}"),
            ),
            PullFile::new(
                "src/totals.ts",
                FileStatus::Added,
                Some(
                    "@@ -0,0 +1,3 @@\n+export function total(items) {\n+  return sum(items, 0)\n+}",
                ),
            ),
        ];
        let renames = HashMap::from([("src/totals.ts".to_owned(), "src/sum.ts".to_owned())]);
        let notes = [
            note_at("src/totals.ts", Side::Old, 2),
            note_at("src/totals.ts", Side::New, 2),
        ];
        let placement = place_notes(&notes, &files, &renames);
        assert!(placement.unplaced.is_empty());
        let mut placed: Vec<(String, Side)> = placement
            .placed
            .iter()
            .map(|p| (p.comment.path.clone(), p.comment.side))
            .collect();
        placed.sort();
        assert_eq!(
            placed,
            [
                ("src/sum.ts".into(), Side::Old),
                ("src/totals.ts".into(), Side::New)
            ]
        );
    }
}

fn gangway() -> RepoRef {
    RepoRef::new("charlesabarnes", "gangway")
}

#[test]
fn finds_the_pr_creates_the_pending_review_and_links_the_notes() {
    let head = tls_head();
    let inline = with(
        note(TLS, &head, line_of(&head, "export function dnsProvider")),
        "Exported only for tests?",
        Severity::Suggestion,
    );
    let outside = with(
        note(
            TLS,
            &head,
            line_of(&head, "      return acmeCertificates(d);"),
        ),
        "Unrelated",
        Severity::Nit,
    );
    let range_start = line_of(&head, "  const acmeDnsUrl");
    let range = with(
        note_on(TLS, &head, range_start, Side::New, Some(range_start + 1)),
        "Both of these",
        Severity::Issue,
    );
    let mut resolved = with(note(TLS, &head, 4), "Done already", Severity::Nit);
    resolved.status = NoteStatus::Resolved;

    let server = FakeGitHub::start(|call, _| match (call.method.as_str(), call.path.as_str()) {
        ("GET", "/repos/charlesabarnes/gangway/pulls") => {
            Some(Reply::json(fixture("pulls-by-head.json")))
        }
        ("GET", "/repos/charlesabarnes/gangway/pulls/48/files") => {
            Some(Reply::json(fixture("pull-files.json")))
        }
        ("POST", "/repos/charlesabarnes/gangway/pulls/48/reviews") => Some(Reply::json(json!({
            "id": 3141, "state": "PENDING",
            "html_url": "https://github.com/charlesabarnes/gangway/pull/48#pullrequestreview-3141"
        }))),
        ("GET", "/repos/charlesabarnes/gangway/pulls/48/reviews/3141/comments") => {
            Some(Reply::json(json!([
                { "id": 2718, "path": TLS, "line": 86, "side": "RIGHT", "body": "**suggestion:** Exported only for tests?" }
            ])))
        }
        _ => None,
    });
    let client = server.client();
    let notes = [
        inline.clone(),
        outside.clone(),
        range.clone(),
        resolved.clone(),
    ];
    let local_head = "f".repeat(40);
    let PushLookup::Ready(preview) = prepare_push(
        &client,
        &gangway(),
        "feat/acme-dns",
        &local_head,
        &notes,
        &no_renames(),
    )
    .unwrap() else {
        panic!("expected a PR");
    };
    assert_eq!(preview.pr.head_sha, HEAD);
    assert_ne!(preview.local_head, preview.pr.head_sha);
    let placed_ids: Vec<&NoteId> = preview
        .placement
        .placed
        .iter()
        .map(|p| &p.note.id)
        .collect();
    assert_eq!(placed_ids, [&inline.id, &range.id]);
    assert_eq!(preview.placement.unplaced[0].note.id, outside.id);

    let selection = PushSelection::from(preview.placement.clone());
    let result = push_pending_review(&client, &gangway(), &preview.pr, &selection).unwrap();
    assert_eq!((result.review.id, result.linked), (3141, 1));

    let post = server
        .calls()
        .into_iter()
        .find(|c| c.method == "POST")
        .unwrap();
    assert_eq!(post.body["commit_id"], HEAD);
    assert_eq!(
        post.body["comments"],
        json!([
            { "path": TLS, "line": 86, "side": "RIGHT", "body": "**suggestion:** Exported only for tests?" },
            { "path": TLS, "start_line": range_start, "start_side": "RIGHT", "line": range_start + 1, "side": "RIGHT", "body": "**issue:** Both of these" },
        ])
    );
    assert!(post.body["body"].as_str().unwrap().contains("Unrelated"));
    assert!(post.body.get("event").is_none());
    assert!(
        server
            .calls()
            .iter()
            .all(|c| c.method == "GET" || c.path.ends_with("/pulls/48/reviews"))
    );

    let links: HashMap<NoteId, GithubComment> = result.links.into_iter().collect();
    assert_eq!(
        links[&inline.id],
        GithubComment {
            review_id: Some(3141),
            comment_id: Some(2718)
        }
    );
    assert_eq!(
        links[&outside.id],
        GithubComment {
            review_id: Some(3141),
            comment_id: None
        }
    );
    assert!(!links.contains_key(&resolved.id));
}

#[test]
fn reports_when_the_branch_has_no_open_pr() {
    let server = FakeGitHub::start(|_, _| Some(Reply::json(json!([]))));
    let lookup = prepare_push(
        &server.client(),
        &gangway(),
        "lonely",
        HEAD,
        &[],
        &no_renames(),
    )
    .unwrap();
    assert_eq!(lookup, PushLookup::NoPullRequest);
}

mod pr_review {
    use super::*;

    const PR_HEAD: &str = "hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh";

    fn acme() -> RepoRef {
        RepoRef::new("acme", "api")
    }

    fn pull() -> PullRequest {
        PullRequest {
            number: 7,
            title: "T".into(),
            html_url: "https://github.com/acme/api/pull/7".into(),
            draft: false,
            head_sha: PR_HEAD.into(),
            head_ref: "f".into(),
            base_ref: "main".into(),
        }
    }

    fn files() -> Vec<PullFile> {
        vec![PullFile::new(
            "src/a.ts",
            FileStatus::Modified,
            Some("@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three"),
        )]
    }

    fn pr_note(id: &str, path: &str) -> Note {
        let anchor = ducky_review::Anchor {
            side: Side::New,
            line: 2,
            end_line: None,
            code: vec!["TWO".into()],
            before: vec!["one".into()],
            after: vec!["three".into()],
        };
        NewNote::new(path, anchor, format!("Body {id}")).into_note(NoteId::new(id), Timestamp(1))
    }

    fn off_diff() -> Note {
        with(
            pr_note("n-off", "src/other.ts"),
            "Not in the PR",
            Severity::Nit,
        )
    }

    fn pending() -> PendingReview {
        PendingReview {
            id: "PRR_9".into(),
            database_id: Some(9),
            body: "Started on GitHub".into(),
            comments: 1,
            url: "https://github.com/acme/api/pull/7#pullrequestreview-9".into(),
        }
    }

    fn review_server() -> FakeGitHub {
        FakeGitHub::start(|call, _| match (call.method.as_str(), call.path.as_str()) {
            ("POST", "/repos/acme/api/pulls/7/reviews") => Some(Reply::json(json!({
                "id": 41,
                "state": if call.body.get("event").is_some() { "COMMENTED" } else { "PENDING" },
                "html_url": "https://github.com/acme/api/pull/7#pullrequestreview-41"
            }))),
            ("POST", "/repos/acme/api/pulls/7/reviews/9/events") => Some(Reply::json(json!({
                "id": 9, "state": "APPROVED", "html_url": "https://github.com/acme/api/pull/7#pullrequestreview-9"
            }))),
            ("PUT", "/repos/acme/api/pulls/7/reviews/9") => Some(Reply::json(json!({ "id": 9 }))),
            ("POST", "/graphql") => Some(Reply::json(json!({
                "data": { "addPullRequestReviewThread": { "thread": { "comments": { "nodes": [{ "databaseId": 777 }] } } } }
            }))),
            _ => None,
        })
    }

    #[test]
    fn summarizes_open_notes_worst_first() {
        let mut resolved = pr_note("c", "src/a.ts");
        resolved.status = NoteStatus::Resolved;
        let summary = review_summary(&[
            with(pr_note("a", "src/a.ts"), "Rename this", Severity::Nit),
            with(
                pr_note("b", "src/a.ts"),
                "Breaks totals\nmore",
                Severity::Blocker,
            ),
            resolved,
        ]);
        assert_eq!(
            summary,
            "2 notes: 1 blocker, 1 nit.\n\n- **blocker** `src/a.ts:2` Breaks totals\n- **nit** `src/a.ts:2` Rename this"
        );
        assert_eq!(review_summary(&[]), "");
    }

    #[test]
    fn previews_pushes_against_the_pr_diff() {
        let mut resolved = pr_note("r", "src/a.ts");
        resolved.status = NoteStatus::Resolved;
        let preview = prepare_pr_push(
            &pull(),
            &files(),
            &[pr_note("a", "src/a.ts"), off_diff(), resolved],
        );
        assert_eq!(preview.local_head, PR_HEAD);
        let c = &preview.placement.placed[0].comment;
        assert_eq!(
            (c.path.as_str(), c.line, c.side, c.body.as_str()),
            ("src/a.ts", 2, Side::New, "**issue:** Body a")
        );
        assert_eq!(preview.placement.unplaced[0].note.id, NoteId::new("n-off"));
    }

    #[test]
    fn creates_and_submits_in_one_call_without_a_pending_review() {
        let server = review_server();
        let to_send = unpushed_notes(&[pr_note("a", "src/a.ts"), off_diff()]);
        let input = SubmitInput {
            event: ReviewEvent::Comment,
            body: "Looks close.".into(),
            placement: Some(place_notes(&to_send, &files(), &no_renames())),
        };
        let result = submit_pr_review(&server.client(), &acme(), 7, PR_HEAD, None, &input).unwrap();
        let calls = server.calls();
        assert_eq!(calls.len(), 1);
        let sent = &calls[0].body;
        assert_eq!(sent["event"], "COMMENT");
        assert_eq!(sent["commit_id"], PR_HEAD);
        assert_eq!(
            sent["comments"],
            json!([{ "path": "src/a.ts", "line": 2, "side": "RIGHT", "body": "**issue:** Body a" }])
        );
        let body = sent["body"].as_str().unwrap();
        assert!(body.starts_with("Looks close.\n\nNotes that do not map onto the diff:"));
        assert!(body.contains("src/other.ts"));
        assert_eq!((result.state, result.comments), ("COMMENTED", 1));
        let links: HashMap<NoteId, GithubComment> = result.links.into_iter().collect();
        assert_eq!(
            links[&NoteId::new("a")],
            GithubComment {
                review_id: Some(41),
                comment_id: None
            }
        );
        let mut linked = pr_note("a", "src/a.ts");
        linked.github = Some(links[&NoteId::new("a")].clone());
        assert!(unpushed_notes(&[linked]).is_empty());
    }

    #[test]
    fn adds_notes_to_the_pending_review_then_approves() {
        let server = review_server();
        let input = SubmitInput {
            event: ReviewEvent::Approve,
            body: String::new(),
            placement: Some(place_notes(
                &[pr_note("a", "src/a.ts")],
                &files(),
                &no_renames(),
            )),
        };
        let result = submit_pr_review(
            &server.client(),
            &acme(),
            7,
            PR_HEAD,
            Some(&pending()),
            &input,
        )
        .unwrap();
        let calls = server.calls();
        let routes: Vec<String> = calls
            .iter()
            .map(|c| format!("{} {}", c.method, c.path))
            .collect();
        assert_eq!(
            routes,
            [
                "POST /graphql",
                "POST /repos/acme/api/pulls/7/reviews/9/events"
            ]
        );
        assert_eq!(
            calls[0].variables(),
            &json!({ "review": "PRR_9", "path": "src/a.ts", "line": 2, "side": "RIGHT", "startLine": null, "startSide": null, "body": "**issue:** Body a" })
        );
        assert_eq!(calls[1].body, json!({ "event": "APPROVE", "body": "" }));
        assert_eq!(result.state, "APPROVED");
        assert_eq!(result.links[0].1.comment_id, Some(777));
    }

    #[test]
    fn sends_a_range_into_the_pending_review_as_a_range() {
        let server = review_server();
        let lines = number_lines("one\nTWO\nthree\n");
        let anchor = create_anchor(&lines, 1, Side::New, Some(2)).unwrap();
        let range =
            NewNote::new("src/a.ts", anchor, "both").into_note(NoteId::new("r"), Timestamp(1));
        let placement = place_notes(&[range], &files(), &no_renames());
        push_to_pending_review(
            &server.client(),
            &acme(),
            7,
            &pending(),
            &PushSelection::from(placement),
        )
        .unwrap();
        let vars = server.calls()[0].variables().clone();
        assert_eq!(
            (
                vars["startLine"].clone(),
                vars["startSide"].clone(),
                vars["line"].clone()
            ),
            (json!(1), json!("RIGHT"), json!(2))
        );
    }

    #[test]
    fn requests_changes_with_only_a_summary() {
        let server = review_server();
        let input = SubmitInput {
            event: ReviewEvent::RequestChanges,
            body: "Needs tests.".into(),
            placement: None,
        };
        let result = submit_pr_review(&server.client(), &acme(), 7, PR_HEAD, None, &input).unwrap();
        let sent = &server.calls()[0].body;
        assert_eq!(
            (&sent["event"], &sent["body"], &sent["comments"]),
            (
                &json!("REQUEST_CHANGES"),
                &json!("Needs tests."),
                &json!([])
            )
        );
        assert_eq!(result.state, "CHANGES_REQUESTED");
    }

    #[test]
    fn knows_when_github_needs_a_body() {
        let comment = |body: &str, placement| SubmitInput {
            event: ReviewEvent::Comment,
            body: body.into(),
            placement,
        };
        assert!(needs_body(&comment(" ", None), 0));
        assert!(!needs_body(&comment(" ", None), 2));
        assert!(!needs_body(
            &SubmitInput {
                event: ReviewEvent::Approve,
                body: String::new(),
                placement: None
            },
            0
        ));
        let placed = place_notes(&[pr_note("a", "src/a.ts")], &files(), &no_renames());
        assert!(!needs_body(
            &SubmitInput {
                event: ReviewEvent::RequestChanges,
                body: String::new(),
                placement: Some(placed)
            },
            0
        ));
        let off = place_notes(&[off_diff()], &files(), &no_renames());
        assert!(submit_body(&comment("", Some(off))).starts_with("Notes that do not map"));
    }

    #[test]
    fn pushes_notes_into_an_existing_pending_review() {
        let server = review_server();
        let placement = place_notes(
            &[pr_note("a", "src/a.ts"), off_diff()],
            &files(),
            &no_renames(),
        );
        let result = push_to_pending_review(
            &server.client(),
            &acme(),
            7,
            &pending(),
            &PushSelection::from(placement),
        )
        .unwrap();
        let calls = server.calls();
        let routes: Vec<String> = calls
            .iter()
            .map(|c| format!("{} {}", c.method, c.path))
            .collect();
        assert_eq!(
            routes,
            ["POST /graphql", "PUT /repos/acme/api/pulls/7/reviews/9"]
        );
        assert!(
            calls[1].body["body"]
                .as_str()
                .unwrap()
                .starts_with("Started on GitHub\n\nNotes that do not map onto the diff:")
        );
        assert_eq!(
            (
                result.review.id,
                result.review.state.as_str(),
                result.linked
            ),
            (9, "PENDING", 1)
        );
        let links: HashMap<NoteId, GithubComment> = result.links.into_iter().collect();
        assert_eq!(
            links[&NoteId::new("a")],
            GithubComment {
                review_id: Some(9),
                comment_id: Some(777)
            }
        );
        assert_eq!(links[&NoteId::new("n-off")].review_id, Some(9));
    }

    #[test]
    fn refuses_a_pending_review_without_an_id() {
        let server = review_server();
        let mut pending = pending();
        pending.database_id = None;
        let error = push_to_pending_review(
            &server.client(),
            &acme(),
            7,
            &pending,
            &PushSelection::default(),
        )
        .unwrap_err();
        assert!(error.message.contains("did not report the id"));
        assert!(server.calls().is_empty());
    }
}
