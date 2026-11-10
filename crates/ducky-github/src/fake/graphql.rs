use serde_json::{Map, Value, json};

use super::server::{Call, Reply};
use super::world::{AUTHOR, NAME, NUMBER, OWNER, State, Thread, VIEWER, Write};

pub(super) fn handle(state: &mut State, call: &Call, _base: &str) -> Option<Reply> {
    let query = call.graphql();
    let vars = call.variables();
    let data = if query.contains("query Inbox") {
        inbox(state)
    } else if query.contains("query Blobs") {
        blobs(state, vars)
    } else if query.contains("query Threads") {
        threads(state)
    } else if query.contains("mutation Reply") {
        reply(state, vars)?
    } else if query.contains("mutation Resolve") || query.contains("mutation Unresolve") {
        resolve(state, vars, query.contains("mutation Resolve"))?
    } else if query.contains("mutation AddThread") {
        add_thread(state, vars)?
    } else {
        return None;
    };
    Some(Reply::json(json!({ "data": data })))
}

fn inbox(state: &State) -> Value {
    let row = |owner: &str, name: &str, number: u64, title: &str, author: &str, extra: Value| {
        let mut node = json!({
            "number": number, "title": title,
            "url": format!("https://github.com/{owner}/{name}/pull/{number}"),
            "isDraft": false, "state": "OPEN",
            "createdAt": "2026-11-05T09:00:00Z", "updatedAt": "2026-11-09T08:15:00Z",
            "additions": 40, "deletions": 9, "changedFiles": 5,
            "author": { "login": author },
            "repository": { "name": name, "owner": { "login": owner } },
            "viewerLatestReview": null,
            "pending": { "totalCount": 0 },
            "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "state": "SUCCESS" } } }] },
        });
        if let (Value::Object(node), Value::Object(extra)) = (&mut node, extra) {
            node.extend(extra);
        }
        node
    };
    let rollup =
        |s: &str| json!({ "nodes": [{ "commit": { "statusCheckRollup": { "state": s } } }] });
    let ours = row(
        OWNER,
        NAME,
        NUMBER,
        "Parse orders from text",
        AUTHOR,
        json!({
            "commits": rollup("FAILURE"),
            "pending": { "totalCount": u32::from(state.pending.is_some()) },
        }),
    );
    let team = row(
        OWNER,
        "gadgets",
        12,
        "Bump serde to 1.0.215",
        "dependabot",
        json!({ "additions": 3, "deletions": 3, "changedFiles": 1 }),
    );
    let draft = row(
        OWNER,
        NAME,
        5,
        "Faster totals with SIMD",
        VIEWER,
        json!({ "isDraft": true, "commits": rollup("PENDING") }),
    );
    let reviewed = row(
        OWNER,
        "api",
        88,
        "Rate limit the export endpoint",
        "carol",
        json!({ "state": "MERGED", "viewerLatestReview": { "state": "APPROVED" }, "commits": { "nodes": [] } }),
    );
    json!({
        "viewer": { "login": VIEWER },
        "requested": { "issueCount": 2, "nodes": [ours, team] },
        "direct": { "nodes": [{ "url": format!("https://github.com/{OWNER}/{NAME}/pull/{NUMBER}") }] },
        "mine": { "issueCount": 1, "nodes": [draft] },
        "reviewed": { "issueCount": 1, "nodes": [reviewed] },
    })
}

fn blobs(state: &State, vars: &Value) -> Value {
    let mut repository = Map::new();
    let Some(map) = vars.as_object() else {
        return json!({ "repository": repository });
    };
    for (key, expression) in map.iter().filter(|(k, _)| k.starts_with('e')) {
        let found = expression
            .as_str()
            .and_then(|e| e.split_once(':'))
            .and_then(|(sha, path)| state.commit(sha)?.files.get(path));
        let value = found.map_or(Value::Null, |content| {
            json!({
                "oid": content.oid(),
                "byteSize": content.bytes().len(),
                "isBinary": matches!(content, super::world::Content::Binary(_)),
            })
        });
        repository.insert(format!("b{}", &key[1..]), value);
    }
    json!({ "repository": repository })
}

fn comment_json(thread: &Thread, comment: &super::world::Comment) -> Value {
    json!({
        "id": format!("PRRC_{}", comment.id),
        "databaseId": comment.id,
        "body": comment.body,
        "createdAt": comment.created_at,
        "url": format!("https://github.com/{OWNER}/{NAME}/pull/{NUMBER}#discussion_r{}", comment.id),
        "state": if comment.pending { "PENDING" } else { "SUBMITTED" },
        "author": { "login": comment.author },
        "path": thread.path,
    })
}

fn thread_json(thread: &Thread) -> Value {
    let resolved = thread.resolved_by.is_some();
    json!({
        "id": thread.id,
        "path": thread.path,
        "line": thread.line,
        "originalLine": thread.original_line,
        "startLine": thread.start_line,
        "diffSide": thread.side,
        "subjectType": if thread.file_level { "FILE" } else { "LINE" },
        "isResolved": resolved,
        "isOutdated": thread.outdated,
        "viewerCanReply": true,
        "viewerCanResolve": !resolved,
        "viewerCanUnresolve": resolved,
        "resolvedBy": thread.resolved_by.as_ref().map(|login| json!({ "login": login })),
        "comments": { "nodes": thread.comments.iter().map(|c| comment_json(thread, c)).collect::<Vec<_>>() },
    })
}

fn threads(state: &State) -> Value {
    let pending: Vec<Value> = state
        .pending
        .iter()
        .map(|p| {
            json!({
                "id": format!("PRR_{}", p.id), "databaseId": p.id, "body": p.body,
                "url": format!("https://github.com/{OWNER}/{NAME}/pull/{NUMBER}#pullrequestreview-{}", p.id),
                "comments": { "totalCount": state.pending_comments() },
            })
        })
        .collect();
    json!({
        "viewer": { "login": VIEWER },
        "repository": { "pullRequest": {
            "id": format!("PR_{NUMBER}"),
            "pending": { "nodes": pending },
            "reviewThreads": {
                "pageInfo": { "hasNextPage": false, "endCursor": null },
                "nodes": state.threads.iter().map(thread_json).collect::<Vec<_>>(),
            },
        }},
    })
}

fn reply(state: &mut State, vars: &Value) -> Option<Value> {
    let id = vars["thread"].as_str()?.to_owned();
    let body = vars["body"].as_str()?.to_owned();
    let comment_id = state.next_id();
    let thread = state.threads.iter_mut().find(|t| t.id == id)?;
    let comment = super::world::Comment {
        id: comment_id,
        author: VIEWER.into(),
        body: body.clone(),
        created_at: "2026-11-10T12:00:00Z".into(),
        pending: false,
    };
    let json = comment_json(thread, &comment);
    thread.comments.push(comment);
    state.writes.push(Write::Reply { thread: id, body });
    Some(json!({ "addPullRequestReviewThreadReply": { "comment": json } }))
}

fn resolve(state: &mut State, vars: &Value, resolved: bool) -> Option<Value> {
    let id = vars["thread"].as_str()?.to_owned();
    let thread = state.threads.iter_mut().find(|t| t.id == id)?;
    thread.resolved_by = resolved.then(|| VIEWER.to_owned());
    state.writes.push(Write::Resolve {
        thread: id.clone(),
        resolved,
    });
    let key = if resolved {
        "resolveReviewThread"
    } else {
        "unresolveReviewThread"
    };
    Some(json!({ key: { "thread": { "id": id, "isResolved": resolved } } }))
}

fn add_thread(state: &mut State, vars: &Value) -> Option<Value> {
    let review = vars["review"].as_str()?;
    let pending = state.pending.as_ref()?;
    if review != format!("PRR_{}", pending.id) {
        return None;
    }
    let path = vars["path"].as_str()?.to_owned();
    let line = vars["line"].as_u64()? as u32;
    let side = if vars["side"].as_str() == Some("LEFT") {
        "LEFT"
    } else {
        "RIGHT"
    };
    let start = vars["startLine"].as_u64().map(|l| l as u32);
    let body = vars["body"].as_str()?.to_owned();
    let thread = super::rest::new_thread(state, &path, line, start, side, &body, true);
    let comment_id = thread.comments[0].id;
    let id = thread.id.clone();
    state.threads.push(thread);
    state.writes.push(Write::AddThread { path, line });
    Some(json!({ "addPullRequestReviewThread": { "thread": {
        "id": id, "comments": { "nodes": [{ "databaseId": comment_id }] },
    }}}))
}
