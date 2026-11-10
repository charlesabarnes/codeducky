mod support;

use ducky_github::ErrorKind;
use ducky_github::inbox::{CiRollup, InboxSection, InboxState, fetch_inbox, inbox_queries};
use ducky_review::Timestamp;
use serde_json::{Value, json};
use support::{FakeGitHub, Reply};

fn now() -> Timestamp {
    Timestamp::utc(2026, 10, 3, 12, 0)
}

fn pr(number: u64, extra: Value) -> Value {
    let mut base = json!({
        "number": number, "title": format!("PR {number}"),
        "url": format!("https://github.com/acme/api/pull/{number}"),
        "isDraft": false, "state": "OPEN",
        "createdAt": "2026-10-01T10:00:00Z", "updatedAt": "2026-10-02T10:00:00Z",
        "additions": 10, "deletions": 2, "changedFiles": 3,
        "author": { "login": "octo" },
        "repository": { "name": "api", "owner": { "login": "acme" } },
        "viewerLatestReview": null,
        "pending": { "totalCount": 0 },
        "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "state": "SUCCESS" } } }] },
    });
    if let (Value::Object(base), Value::Object(extra)) = (&mut base, extra) {
        base.extend(extra);
    }
    base
}

fn rollup(state: Option<&str>) -> Value {
    json!({ "nodes": [{ "commit": { "statusCheckRollup": state.map(|s| json!({ "state": s })) } }] })
}

#[test]
fn asks_for_every_section_in_one_request() {
    let server = FakeGitHub::start(|call, _| {
        (call.method == "POST" && call.path == "/graphql").then(|| {
            Reply::json(json!({ "data": {
                "viewer": { "login": "me" },
                "requested": { "issueCount": 3, "nodes": [
                    pr(1, json!({})),
                    pr(2, json!({ "isDraft": true, "pending": { "totalCount": 1 }, "commits": rollup(Some("FAILURE")) })),
                    {},
                ] },
                "direct": { "nodes": [{ "url": "https://github.com/acme/api/pull/1" }] },
                "mine": { "issueCount": 1, "nodes": [pr(5, json!({ "author": { "login": "me" }, "commits": rollup(None) }))] },
                "reviewed": { "issueCount": 1, "nodes": [pr(9, json!({ "viewerLatestReview": { "state": "APPROVED" }, "state": "MERGED" }))] },
            } }))
        })
    });
    let inbox = fetch_inbox(&server.client(), now()).unwrap();
    let call = &server.calls()[0];
    assert_eq!(call.variables(), &inbox_queries(now()));
    assert!(
        call.variables()["requested"]
            .as_str()
            .unwrap()
            .contains("review-requested:@me")
    );
    assert!(
        call.variables()["mine"]
            .as_str()
            .unwrap()
            .contains("author:@me")
    );
    assert!(
        call.variables()["reviewed"]
            .as_str()
            .unwrap()
            .contains("reviewed-by:@me")
    );

    assert_eq!(inbox.viewer, "me");
    assert_eq!(inbox.totals, [3, 1, 1]);
    let numbers: Vec<u64> = inbox
        .section(InboxSection::Requested)
        .iter()
        .map(|r| r.number)
        .collect();
    assert_eq!(
        numbers,
        [1, 2],
        "the empty node (a repo the token cannot read) is dropped"
    );
    let first = &inbox.requested[0];
    assert_eq!(
        (
            first.owner.as_str(),
            first.name.as_str(),
            first.ci,
            first.via_team,
            first.pending_review
        ),
        ("acme", "api", CiRollup::Pass, false, false)
    );
    assert_eq!(
        (first.additions, first.deletions, first.changed_files),
        (10, 2, 3)
    );
    let second = &inbox.requested[1];
    assert_eq!(
        (
            second.draft,
            second.ci,
            second.via_team,
            second.pending_review
        ),
        (true, CiRollup::Fail, true, true)
    );
    assert_eq!(
        (inbox.mine[0].ci, inbox.mine[0].via_team),
        (CiRollup::None, false)
    );
    assert_eq!(
        (
            inbox.reviewed[0].my_review.as_deref(),
            inbox.reviewed[0].state
        ),
        (Some("APPROVED"), InboxState::Merged)
    );
    assert_eq!(inbox.total(InboxSection::Mine), 1);
}

#[test]
fn keeps_partial_results_when_some_repositories_are_unreadable() {
    let server = FakeGitHub::start(|_, _| {
        Some(Reply::json(json!({
            "data": { "viewer": { "login": "me" }, "requested": { "issueCount": 1, "nodes": [pr(1, json!({}))] }, "direct": null, "mine": null, "reviewed": null },
            "errors": [{ "type": "FORBIDDEN", "message": "Resource not accessible by personal access token" }],
        })))
    });
    let inbox = fetch_inbox(&server.client(), now()).unwrap();
    assert_eq!(inbox.requested.len(), 1);
    assert!(inbox.mine.is_empty());
}

#[test]
fn reports_a_token_without_access_as_forbidden() {
    let server = FakeGitHub::start(|_, _| {
        Some(Reply::json(
            json!({ "data": null, "errors": [{ "type": "FORBIDDEN", "message": "Resource not accessible by personal access token" }] }),
        ))
    });
    let error = fetch_inbox(&server.client(), now()).unwrap_err();
    assert_eq!(error.kind, ErrorKind::Forbidden);
    assert!(error.message.contains("fine-grained token must include"));
}

#[test]
fn reports_a_rest_403_as_forbidden_too() {
    let server = FakeGitHub::start(|_, _| {
        Some(
            Reply::json(json!({ "message": "Forbidden" }))
                .status(403)
                .header("x-ratelimit-remaining", "10"),
        )
    });
    assert_eq!(
        fetch_inbox(&server.client(), now()).unwrap_err().kind,
        ErrorKind::Forbidden
    );
}
