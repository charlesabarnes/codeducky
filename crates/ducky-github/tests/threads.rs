mod support;

use ducky_github::threads::{
    NewThread, ReviewThread, add_thread_to_review, fetch_threads, order_threads, place_threads,
    reply_to_thread, set_thread_resolved,
};
use ducky_github::{ErrorKind, RepoRef, Side};
use serde_json::{Value, json};
use support::{FakeGitHub, Reply};

fn acme() -> RepoRef {
    RepoRef::new("acme", "api")
}

fn comment(id: &str, extra: Value) -> Value {
    let mut base = json!({
        "id": id,
        "databaseId": id.chars().filter(char::is_ascii_digit).collect::<String>().parse::<u64>().unwrap_or(1),
        "body": format!("Body {id}"),
        "createdAt": "2026-10-01T10:00:00Z",
        "url": format!("https://github.com/acme/api/pull/7#discussion_r{id}"),
        "state": "SUBMITTED",
        "author": { "login": "octo" },
    });
    merge(&mut base, extra);
    base
}

fn thread(id: &str, extra: Value) -> Value {
    let mut base = json!({
        "id": id, "path": "src/a.ts", "line": 12, "originalLine": 10, "startLine": null,
        "diffSide": "RIGHT", "subjectType": "LINE", "isResolved": false, "isOutdated": false,
        "viewerCanReply": true, "viewerCanResolve": true, "viewerCanUnresolve": false,
        "resolvedBy": null, "comments": { "nodes": [comment(&format!("{id}-c1"), json!({}))] },
    });
    merge(&mut base, extra);
    base
}

fn merge(base: &mut Value, extra: Value) {
    if let (Value::Object(base), Value::Object(extra)) = (base, extra) {
        base.extend(extra);
    }
}

fn page(nodes: Vec<Value>, has_next: bool, cursor: Option<&str>, pending: Vec<Value>) -> Value {
    json!({ "data": {
        "viewer": { "login": "me" },
        "repository": { "pullRequest": {
            "id": "PR_1",
            "pending": { "nodes": pending },
            "reviewThreads": { "pageInfo": { "hasNextPage": has_next, "endCursor": cursor }, "nodes": nodes },
        } },
    } })
}

fn to_thread(raw: Value) -> ReviewThread {
    let server = FakeGitHub::start(move |_, _| {
        Some(Reply::json(page(vec![raw.clone()], false, None, vec![])))
    });
    fetch_threads(&server.client(), &acme(), 7)
        .unwrap()
        .threads
        .remove(0)
}

#[test]
fn pages_through_threads_and_finds_your_pending_review() {
    let server = FakeGitHub::start(|call, _| {
        Some(Reply::json(if call.variables()["after"].is_null() {
            page(
                vec![
                    thread("T1", json!({})),
                    thread(
                        "T2",
                        json!({ "isOutdated": true, "line": null, "diffSide": "LEFT" }),
                    ),
                ],
                true,
                Some("c1"),
                vec![
                    json!({ "id": "PRR_9", "databaseId": 9, "body": "Draft", "url": "u", "comments": { "totalCount": 2 } }),
                ],
            )
        } else {
            page(
                vec![
                    thread("T3", json!({ "subjectType": "FILE", "line": null })),
                    Value::Null,
                ],
                false,
                None,
                vec![],
            )
        }))
    });
    let result = fetch_threads(&server.client(), &acme(), 7).unwrap();
    let calls = server.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[1].variables()["after"], "c1");
    assert_eq!(calls[0].variables()["number"], 7);
    assert_eq!(
        (result.viewer.as_str(), result.pull_id.as_str()),
        ("me", "PR_1")
    );
    let pending = result.pending_review.unwrap();
    assert_eq!(
        (
            pending.id.as_str(),
            pending.database_id,
            pending.body.as_str(),
            pending.comments,
            pending.url.as_str()
        ),
        ("PRR_9", Some(9), "Draft", 2, "u")
    );
    let ids: Vec<&str> = result.threads.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, ["T1", "T2", "T3"]);
    let first = &result.threads[0];
    assert_eq!(
        (first.side, first.line, first.can_resolve),
        (Side::New, Some(12), true)
    );
    assert_eq!(
        (first.comments[0].author.as_str(), first.comments[0].pending),
        ("octo", false)
    );
    assert_eq!(
        (
            result.threads[1].side,
            result.threads[1].line,
            result.threads[1].is_outdated
        ),
        (Side::Old, None, true)
    );
    assert!(result.threads[2].file_level);
}

#[test]
fn fails_clearly_when_the_pull_request_is_missing() {
    let server = FakeGitHub::start(|_, _| {
        Some(Reply::json(
            json!({ "data": { "viewer": { "login": "me" }, "repository": { "pullRequest": null } } }),
        ))
    });
    let error = fetch_threads(&server.client(), &acme(), 99).unwrap_err();
    assert_eq!(error.kind, ErrorKind::NotFound);
    assert!(error.message.contains("#99 was not found"));
}

#[test]
fn puts_current_threads_on_their_lines_and_lists_the_rest() {
    let threads = [
        to_thread(thread("A", json!({}))),
        to_thread(thread("B", json!({ "line": 12 }))),
        to_thread(thread("C", json!({ "diffSide": "LEFT", "line": 4 }))),
        to_thread(thread("D", json!({ "isOutdated": true, "line": 30 }))),
        to_thread(thread("E", json!({ "subjectType": "FILE", "line": null }))),
    ];
    assert_eq!(
        threads[3].line, None,
        "an outdated thread drops its stale line"
    );
    let placed = place_threads(&threads);
    let keys: Vec<(Side, u32)> = placed.by_line.keys().copied().collect();
    assert_eq!(keys, [(Side::Old, 4), (Side::New, 12)]);
    let on_12: Vec<&str> = placed.by_line[&(Side::New, 12)]
        .iter()
        .map(|t| t.id.as_str())
        .collect();
    assert_eq!(on_12, ["A", "B"]);
    let listed: Vec<&str> = placed.listed.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(listed, ["D", "E"]);
}

#[test]
fn orders_threads_by_file_then_listed_then_line() {
    let threads = [
        to_thread(thread("late", json!({ "path": "b.ts", "line": 50 }))),
        to_thread(thread("early", json!({ "path": "b.ts", "line": 2 }))),
        to_thread(thread(
            "outdated",
            json!({ "path": "b.ts", "isOutdated": true }),
        )),
        to_thread(thread("first", json!({ "path": "a.ts", "line": 9 }))),
        to_thread(thread("elsewhere", json!({ "path": "not-in-diff.ts" }))),
    ];
    let ordered: Vec<String> = order_threads(&threads, &["a.ts", "b.ts"])
        .into_iter()
        .map(|t| t.id)
        .collect();
    assert_eq!(ordered, ["first", "outdated", "early", "late"]);
}

#[test]
fn replies_resolves_and_unresolves_through_mutations() {
    let server = FakeGitHub::start(|call, _| {
        let query = call.graphql();
        let data = if query.contains("addPullRequestReviewThreadReply") {
            json!({ "addPullRequestReviewThreadReply": { "comment": comment("R1", json!({ "body": "Thanks" })) } })
        } else if query.contains("unresolveReviewThread") {
            json!({ "unresolveReviewThread": { "thread": { "id": "T1", "isResolved": false } } })
        } else if query.contains("resolveReviewThread") {
            json!({ "resolveReviewThread": { "thread": { "id": "T1", "isResolved": true } } })
        } else if query.contains("addPullRequestReviewThread(") {
            json!({ "addPullRequestReviewThread": { "thread": { "comments": { "nodes": [{ "databaseId": 555 }] } } } })
        } else {
            return None;
        };
        Some(Reply::json(json!({ "data": data })))
    });
    let client = server.client();
    let reply = reply_to_thread(&client, "T1", "Thanks").unwrap();
    assert_eq!(
        (reply.body.as_str(), reply.author.as_str()),
        ("Thanks", "octo")
    );
    assert_eq!(
        server.calls()[0].variables(),
        &json!({ "thread": "T1", "body": "Thanks" })
    );
    assert!(set_thread_resolved(&client, "T1", true).unwrap());
    assert!(!set_thread_resolved(&client, "T1", false).unwrap());
    let calls = server.calls();
    assert!(
        calls[1]
            .graphql()
            .contains("resolveReviewThread(input: { threadId: $thread })")
    );
    assert!(calls[2].graphql().contains("unresolveReviewThread"));
    let thread = NewThread {
        path: "src/a.ts",
        line: 3,
        side: Side::New,
        start_line: None,
        start_side: None,
        body: "x",
    };
    assert_eq!(
        add_thread_to_review(&client, "PRR_9", &thread).unwrap(),
        Some(555)
    );
    assert_eq!(
        server.calls()[3].variables(),
        &json!({ "review": "PRR_9", "path": "src/a.ts", "line": 3, "side": "RIGHT", "startLine": null, "startSide": null, "body": "x" })
    );
}

#[test]
fn surfaces_mutation_errors() {
    let server = FakeGitHub::start(|_, _| {
        Some(Reply::json(json!({
            "data": { "resolveReviewThread": null },
            "errors": [{ "type": "FORBIDDEN", "message": "Resource not accessible by personal access token" }]
        })))
    });
    let error = set_thread_resolved(&server.client(), "T1", true).unwrap_err();
    assert_eq!(error.kind, ErrorKind::Forbidden);
}
