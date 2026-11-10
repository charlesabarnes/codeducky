use base64::Engine;
use serde_json::{Value, json};

use super::server::{Call, Reply};
use super::world::{
    AUTHOR, Auth, BRANCH, Commit, Content, NAME, NUMBER, OWNER, State, VIEWER, Write,
};

const CREATED: &str = "2026-11-05T09:00:00Z";

pub(super) fn handle(state: &mut State, call: &Call, base: &str) -> Option<Reply> {
    if call.path == "/user" {
        let scopes = match state.auth {
            Auth::MissingScopes => "read:org, gist",
            _ => "repo, read:org",
        };
        return Some(
            Reply::json(json!({ "login": VIEWER, "name": "Duck Reviewer" }))
                .header("x-oauth-scopes", scopes),
        );
    }
    let prefix = format!("/repos/{OWNER}/{NAME}");
    let rest = call.path.strip_prefix(&prefix)?;
    let parts: Vec<&str> = rest.trim_start_matches('/').split('/').collect();
    let method = call.method.as_str();
    let html = format!("https://github.com/{OWNER}/{NAME}/pull/{NUMBER}");
    let number = NUMBER.to_string();
    match (method, parts.as_slice()) {
        ("GET", [""]) => Some(Reply::json(json!({
            "full_name": format!("{OWNER}/{NAME}"),
            "default_branch": "main",
            "private": false,
            "html_url": format!("https://github.com/{OWNER}/{NAME}"),
            "permissions": { "push": true },
        }))),
        ("GET", ["pulls"]) => {
            let head = call.query.get("head").cloned().unwrap_or_default();
            let found = head == format!("{OWNER}:{BRANCH}");
            Some(Reply::json(if found {
                json!([pull_json(state)])
            } else {
                json!([])
            }))
        }
        ("GET", ["pulls", n]) if *n == number => Some(Reply::json(pull_json(state))),
        ("GET", ["pulls", n, "files"]) if *n == number => Some(Reply::json(Value::Array(
            changed_files(state.base(), state.head()),
        ))),
        ("GET", ["pulls", n, "commits"]) if *n == number => {
            let commits: Vec<Value> = state
                .commits
                .windows(2)
                .map(|pair| commit_json(&pair[1], &pair[0].sha))
                .collect();
            Some(Reply::json(Value::Array(commits)))
        }
        ("GET", ["pulls", n, "reviews"]) if *n == number => {
            let reviews: Vec<Value> = state
                .reviews
                .iter()
                .map(|r| {
                    json!({
                        "id": r.id, "node_id": format!("PRR_{}", r.id), "user": { "login": r.author },
                        "state": r.state, "body": r.body, "submitted_at": CREATED,
                        "html_url": format!("{html}#pullrequestreview-{}", r.id),
                        "commit_id": state.head().sha,
                    })
                })
                .collect();
            Some(Reply::json(Value::Array(reviews)))
        }
        ("POST", ["pulls", n, "reviews"]) if *n == number => {
            Some(create_review(state, call, &html))
        }
        ("GET", ["pulls", n, "reviews", id, "comments"]) if *n == number => {
            let id: u64 = id.parse().ok()?;
            let pending = state.pending.as_ref().is_some_and(|p| p.id == id);
            let comments: Vec<Value> = state
                .threads
                .iter()
                .flat_map(|t| t.comments.iter().map(move |c| (t, c)))
                .filter(|(_, c)| c.pending == pending && c.author == VIEWER)
                .map(|(t, c)| {
                    json!({ "id": c.id, "path": t.path, "line": t.line, "side": t.side, "body": c.body })
                })
                .collect();
            Some(Reply::json(Value::Array(comments)))
        }
        ("POST", ["pulls", n, "reviews", id, "events"]) if *n == number => {
            let id: u64 = id.parse().ok()?;
            submit_pending(state, call, id, &html)
        }
        ("PUT", ["pulls", n, "reviews", id]) if *n == number => {
            let id: u64 = id.parse().ok()?;
            let body = call.body["body"].as_str().unwrap_or_default().to_owned();
            let pending = state.pending.as_mut().filter(|p| p.id == id)?;
            pending.body = body.clone();
            state.writes.push(Write::UpdateReviewBody {
                review_id: id,
                body,
            });
            Some(Reply::json(
                json!({ "id": id, "state": "PENDING", "html_url": html }),
            ))
        }
        ("GET", ["issues", n, "comments"]) if *n == number => Some(Reply::json(json!([]))),
        ("GET", ["compare", range]) => {
            let (from, to) = range.split_once("...")?;
            let (a, b) = (state.commit(from)?, state.commit(to)?);
            let ahead = state.commits.iter().position(|c| c.sha == b.sha)?
                - state.commits.iter().position(|c| c.sha == a.sha)?;
            Some(Reply::json(json!({
                "status": if ahead == 0 { "identical" } else { "ahead" },
                "ahead_by": ahead, "behind_by": 0,
                "merge_base_commit": { "sha": a.sha },
                "files": changed_files(a, b),
            })))
        }
        ("GET", ["git", "ref", "heads", ..]) => {
            let branch = parts[3..].join("/");
            let sha = match branch.as_str() {
                "main" => state.base().sha.clone(),
                BRANCH => state.head().sha.clone(),
                _ => return None,
            };
            Some(Reply::json(json!({ "object": { "sha": sha } })))
        }
        ("GET", ["git", "blobs", oid]) => {
            let content = state
                .commits
                .iter()
                .flat_map(|c| c.files.values())
                .find(|content| content.oid() == *oid)?;
            let encoded = base64::engine::general_purpose::STANDARD.encode(content.bytes());
            Some(Reply::json(
                json!({ "content": encoded, "encoding": "base64" }),
            ))
        }
        ("GET", ["commits", sha]) => state
            .commit(sha)
            .map(|c| Reply::json(json!({ "sha": c.sha }))),
        ("GET", ["commits", sha, "check-runs"]) => {
            state.commit(sha)?;
            state.check_polls += 1;
            Some(Reply::json(check_runs(state, base)))
        }
        ("GET", ["check-runs", id, "annotations"]) => Some(Reply::json(annotations(state, id))),
        ("GET", ["commits", sha, "status"]) => {
            state.commit(sha)?;
            Some(Reply::json(json!({ "statuses": [{
                "context": "ci/legacy", "state": "success", "description": "Legacy checks passed",
                "target_url": null,
            }] })))
        }
        _ => None,
    }
}

pub(super) fn pull_json(state: &State) -> Value {
    json!({
        "number": NUMBER,
        "title": "Parse orders from text",
        "html_url": format!("https://github.com/{OWNER}/{NAME}/pull/{NUMBER}"),
        "draft": false,
        "head": { "sha": state.head().sha, "ref": BRANCH, "repo": { "full_name": format!("{OWNER}/{NAME}") } },
        "base": { "sha": state.base().sha, "ref": "main", "repo": { "full_name": format!("{OWNER}/{NAME}") } },
        "body": "Adds `parse::parse_order` and discounts.\n\n- parses one item per line\n- `discounted` takes a percentage",
        "state": "open",
        "merged": false,
        "user": { "login": AUTHOR },
        "labels": [{ "name": "feature", "color": "0e8a16" }],
        "requested_reviewers": [{ "login": VIEWER }, { "login": "erin" }],
        "requested_teams": [{ "slug": "core" }],
        "additions": 40, "deletions": 9, "changed_files": 5,
        "created_at": CREATED, "updated_at": "2026-11-09T08:15:00Z",
    })
}

fn commit_json(commit: &Commit, parent: &str) -> Value {
    json!({
        "sha": commit.sha,
        "parents": [{ "sha": parent }],
        "commit": { "message": commit.message, "author": { "name": "Octo Cat", "date": CREATED } },
        "author": { "login": AUTHOR },
    })
}

fn patch(old: &str, new: &str) -> (String, u32, u32) {
    let diff = similar::TextDiff::from_lines(old, new);
    let text = diff.unified_diff().context_radius(3).to_string();
    let (mut adds, mut dels) = (0, 0);
    for change in diff.iter_all_changes() {
        match change.tag() {
            similar::ChangeTag::Insert => adds += 1,
            similar::ChangeTag::Delete => dels += 1,
            similar::ChangeTag::Equal => {}
        }
    }
    (text.trim_end_matches('\n').to_owned(), adds, dels)
}

/// The changed files from `a` to `b`, shaped like GitHub's file list.
pub(super) fn changed_files(a: &Commit, b: &Commit) -> Vec<Value> {
    let mut paths: Vec<&String> = a.files.keys().chain(b.files.keys()).collect();
    paths.sort();
    paths.dedup();
    paths
        .into_iter()
        .filter_map(|path| {
            let (old, new) = (a.files.get(path), b.files.get(path));
            let status = match (old, new) {
                (None, Some(_)) => "added",
                (Some(_), None) => "removed",
                (Some(o), Some(n)) if o.bytes() != n.bytes() => "modified",
                _ => return None,
            };
            fn as_text(c: Option<&Content>) -> Option<&str> {
                match c {
                    Some(Content::Text(t)) => Some(t.as_str()),
                    None => Some(""),
                    Some(Content::Binary(_)) => None,
                }
            }
            let diff = as_text(old).zip(as_text(new)).map(|(o, n)| patch(o, n));
            let sha = new.or(old).map(Content::oid);
            Some(json!({
                "filename": path,
                "status": status,
                "sha": sha,
                "patch": diff.as_ref().map(|d| d.0.clone()),
                "additions": diff.as_ref().map_or(0, |d| d.1),
                "deletions": diff.as_ref().map_or(0, |d| d.2),
            }))
        })
        .collect()
}

fn check_runs(state: &State, base: &str) -> Value {
    let green = state.check_polls > state.polls_until_green;
    let run = |id: u64, name: &str, status: &str, conclusion: Option<&str>, count: u32| {
        json!({
            "id": id, "name": name, "status": status, "conclusion": conclusion,
            "html_url": format!("{base}/fake/runs/{id}"), "details_url": null,
            "output": { "title": format!("{name} output"), "annotations_count": count },
            "app": { "name": "GitHub Actions" },
        })
    };
    let test = if green {
        run(3, "test", "completed", Some("success"), 0)
    } else {
        run(3, "test", "in_progress", None, 0)
    };
    json!({
        "total_count": 3,
        "check_runs": [
            run(1, "build", "completed", Some("success"), 0),
            run(2, "lint", "completed", Some("failure"), 2),
            test,
        ]
    })
}

fn annotations(state: &State, id: &str) -> Value {
    if id != "2" {
        return json!([]);
    }
    let lib = match state.head().files.get("src/lib.rs") {
        Some(Content::Text(text)) => text.clone(),
        _ => String::new(),
    };
    let line = super::world::line_of(&lib, "(100 - percent)");
    json!([
        {
            "path": "src/lib.rs", "start_line": line, "end_line": line,
            "annotation_level": "warning", "title": "clippy::arithmetic_side_effects",
            "message": "this subtraction can underflow when `percent` > 100", "raw_details": null,
        },
        {
            "path": "build.rs", "start_line": 3, "end_line": 3,
            "annotation_level": "failure", "title": "unused_variables",
            "message": "unused variable: `unused`", "raw_details": null,
        },
    ])
}

fn create_review(state: &mut State, call: &Call, html: &str) -> Reply {
    let event = call.body["event"].as_str().map(str::to_owned);
    if event.is_none() && state.pending.is_some() {
        return Reply::json(json!({
            "message": "Unprocessable Entity",
            "errors": ["User can only have one pending review per pull request"],
        }))
        .status(422);
    }
    let id = state.next_id();
    let body = call.body["body"].as_str().unwrap_or_default().to_owned();
    let comments = call.body["comments"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    state.writes.push(Write::CreateReview {
        event: event.clone(),
        comments: comments.len(),
        body: body.clone(),
    });
    for comment in &comments {
        let thread = new_thread(
            state,
            comment["path"].as_str().unwrap_or_default(),
            comment["line"].as_u64().unwrap_or(1) as u32,
            comment["start_line"].as_u64().map(|l| l as u32),
            if comment["side"].as_str() == Some("LEFT") {
                "LEFT"
            } else {
                "RIGHT"
            },
            comment["body"].as_str().unwrap_or_default(),
            event.is_none(),
        );
        state.threads.push(thread);
    }
    let review_state = match event.as_deref() {
        None => {
            state.pending = Some(super::world::Pending { id, body });
            "PENDING".to_owned()
        }
        Some(event) => {
            let submitted = submitted_state(event);
            state.reviews.push(super::world::Submitted {
                id,
                author: VIEWER.into(),
                state: submitted.clone(),
                body,
            });
            submitted
        }
    };
    Reply::json(json!({
        "id": id, "state": review_state,
        "html_url": format!("{html}#pullrequestreview-{id}"),
    }))
}

fn submitted_state(event: &str) -> String {
    match event {
        "APPROVE" => "APPROVED",
        "REQUEST_CHANGES" => "CHANGES_REQUESTED",
        _ => "COMMENTED",
    }
    .to_owned()
}

fn submit_pending(state: &mut State, call: &Call, id: u64, html: &str) -> Option<Reply> {
    let pending = state.pending.take().filter(|p| p.id == id)?;
    let event = call.body["event"].as_str().unwrap_or("COMMENT").to_owned();
    let body = call.body["body"]
        .as_str()
        .map_or(pending.body.clone(), str::to_owned);
    for comment in state.threads.iter_mut().flat_map(|t| t.comments.iter_mut()) {
        comment.pending = false;
    }
    let submitted = submitted_state(&event);
    state.writes.push(Write::SubmitReview {
        review_id: id,
        event,
        body: body.clone(),
    });
    state.reviews.push(super::world::Submitted {
        id,
        author: VIEWER.into(),
        state: submitted.clone(),
        body,
    });
    Some(Reply::json(json!({
        "id": id, "state": submitted,
        "html_url": format!("{html}#pullrequestreview-{id}"),
    })))
}

pub(super) fn new_thread(
    state: &mut State,
    path: &str,
    line: u32,
    start_line: Option<u32>,
    side: &'static str,
    body: &str,
    pending: bool,
) -> super::world::Thread {
    let id = state.next_id();
    super::world::Thread {
        id: format!("PRRT_{id}"),
        path: path.to_owned(),
        line: Some(line),
        original_line: Some(line),
        start_line,
        side,
        file_level: false,
        resolved_by: None,
        outdated: false,
        comments: vec![super::world::Comment {
            id: state.next_id(),
            author: VIEWER.into(),
            body: body.to_owned(),
            created_at: "2026-11-10T12:00:00Z".into(),
            pending,
        }],
    }
}
