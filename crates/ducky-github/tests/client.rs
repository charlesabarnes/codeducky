mod support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ducky_github::{
    Client, CompareStatus, ErrorKind, FileStatus, RepoRef, ReviewCommentInput, ReviewInput, Side,
    Token,
};
use serde_json::json;
use support::{FakeGitHub, Reply, fixture};

const HEAD: &str = "118bade96cd67e73abb7a355f5fc5f6a846805b8";
const BASE: &str = "cc550430fddb0cdc88d38a7fd88b06ba043eee90";

fn repo() -> RepoRef {
    RepoRef::new("charlesabarnes", "gangway")
}

#[test]
fn sends_the_token_and_api_version_and_reads_the_viewer() {
    let server = FakeGitHub::start(|call, _| {
        (call.path == "/user").then(|| {
            Reply::json(json!({ "login": "charlesabarnes", "id": 1, "name": "Charles Barnes" }))
                .header(
                    "github-authentication-token-expiration",
                    "2026-12-31 23:59:59 UTC",
                )
        })
    });
    let viewer = server.client().viewer().unwrap();
    assert_eq!(viewer.login, "charlesabarnes");
    assert_eq!(viewer.name.as_deref(), Some("Charles Barnes"));
    assert_eq!(
        viewer.token_expires_at.as_deref(),
        Some("2026-12-31 23:59:59 UTC")
    );
    assert_eq!(viewer.scopes, None);
    let headers = &server.calls()[0].headers;
    assert_eq!(headers["authorization"], "Bearer github_pat_test");
    assert_eq!(headers["accept"], "application/vnd.github+json");
    assert_eq!(headers["x-github-api-version"], "2022-11-28");
    assert_eq!(headers["user-agent"], "codeducky");
}

#[test]
fn lists_classic_token_scopes() {
    let server = FakeGitHub::start(|_, _| {
        Some(Reply::json(json!({ "login": "me" })).header("x-oauth-scopes", "repo, read:org"))
    });
    let viewer = server.client().viewer().unwrap();
    assert_eq!(viewer.scopes, Some(vec!["repo".into(), "read:org".into()]));
}

#[test]
fn reads_the_default_branch_and_branch_heads() {
    let server = FakeGitHub::start(|call, _| match call.path.as_str() {
        "/repos/charlesabarnes/gangway" => Some(Reply::json(fixture("repo.json"))),
        "/repos/charlesabarnes/gangway/git/ref/heads/master" => {
            Some(Reply::json(fixture("ref-master.json")))
        }
        "/repos/charlesabarnes/gangway/git/ref/heads/feat/gone" => {
            Some(Reply::json(json!({ "message": "Not Found" })).status(404))
        }
        _ => None,
    });
    let client = server.client();
    let summary = client.repo(&repo()).unwrap();
    assert_eq!(summary.default_branch, "master");
    assert_eq!(summary.full_name, "charlesabarnes/gangway");
    assert_eq!(summary.can_push, None);
    assert_eq!(
        client.branch_head(&repo(), "master").unwrap().as_deref(),
        Some(BASE)
    );
    assert_eq!(client.branch_head(&repo(), "feat/gone").unwrap(), None);
}

#[test]
fn treats_a_missing_commit_as_not_pushed() {
    let server = FakeGitHub::start(|call, _| {
        if call.path.ends_with(HEAD) {
            Some(Reply::json(json!({ "sha": HEAD })))
        } else {
            Some(Reply::json(json!({ "message": "No commit found for SHA: 0000000" })).status(422))
        }
    });
    let client = server.client();
    assert!(client.commit_exists(&repo(), HEAD).unwrap());
    assert!(!client.commit_exists(&repo(), &"0".repeat(40)).unwrap());
}

#[test]
fn compares_two_commits_and_returns_the_merge_base() {
    let server = FakeGitHub::start(|call, _| {
        call.path
            .contains("/compare/")
            .then(|| Reply::json(fixture("compare.json")))
    });
    let comparison = server.client().compare(&repo(), BASE, HEAD).unwrap();
    assert_eq!(
        server.calls()[0].path,
        format!("/repos/charlesabarnes/gangway/compare/{BASE}...{HEAD}")
    );
    assert_eq!(comparison.status, CompareStatus::Ahead);
    assert_eq!((comparison.ahead_by, comparison.behind_by), (5, 0));
    assert_eq!(comparison.merge_base_sha, BASE);
    assert_eq!(comparison.files.len(), 13);
    let added = comparison
        .files
        .iter()
        .find(|f| f.path == "server/src/tls/dns/acme-dns.ts")
        .unwrap();
    assert_eq!(
        (added.status, added.previous_path.as_deref()),
        (FileStatus::Added, None)
    );
}

#[test]
fn finds_the_open_pull_request_for_a_branch() {
    let server = FakeGitHub::start(|call, _| {
        if call.path != "/repos/charlesabarnes/gangway/pulls" {
            return None;
        }
        Some(Reply::json(
            if call.query["head"] == "charlesabarnes:feat/acme-dns" {
                fixture("pulls-by-head.json")
            } else {
                json!([])
            },
        ))
    });
    let client = server.client();
    let pr = client
        .open_pull_for_branch(&repo(), "feat/acme-dns", None)
        .unwrap()
        .unwrap();
    assert_eq!(server.calls()[0].query["state"], "open");
    assert_eq!(pr.number, 48);
    assert_eq!(
        pr.title,
        "Get certificates through acme-dns when DNS is not on Cloudflare"
    );
    assert_eq!(
        pr.html_url,
        "https://github.com/charlesabarnes/gangway/pull/48"
    );
    assert!(!pr.draft);
    assert_eq!(
        (
            pr.head_sha.as_str(),
            pr.head_ref.as_str(),
            pr.base_ref.as_str()
        ),
        (HEAD, "feat/acme-dns", "master")
    );
    assert_eq!(
        client
            .open_pull_for_branch(&repo(), "nothing", None)
            .unwrap(),
        None
    );
}

#[test]
fn follows_link_headers_through_every_page() {
    let files = fixture("pull-files.json");
    let files = files.as_array().unwrap().clone();
    let server = FakeGitHub::start(move |call, base| {
        if call.path == "/repositories/1382558758/pulls/48/files"
            && call.search == "per_page=10&page=2"
        {
            return Some(Reply::json(json!(files[10..])));
        }
        if call.path == "/repos/charlesabarnes/gangway/pulls/48/files"
            && call.search == "per_page=100"
        {
            let next = format!("{base}/repositories/1382558758/pulls/48/files?per_page=10&page=2");
            return Some(Reply::json(json!(files[..10])).header(
                "link",
                format!(r#"<{next}>; rel="next", <{next}>; rel="last""#),
            ));
        }
        None
    });
    let result = server.client().pull_files(&repo(), 48).unwrap();
    let searches: Vec<String> = server.calls().into_iter().map(|c| c.search).collect();
    assert_eq!(searches, ["per_page=100", "per_page=10&page=2"]);
    assert_eq!(result.len(), 13);
    assert_eq!(
        (result[0].path.as_str(), result[0].status),
        ("compose.yaml", FileStatus::Modified)
    );
    let tls = result
        .iter()
        .find(|f| f.path == "server/src/boot/tls.ts")
        .unwrap();
    assert!(tls.patch.as_deref().unwrap().starts_with("@@ -1,6 +1,7 @@"));
}

#[test]
fn never_follows_a_link_off_the_api() {
    let server = FakeGitHub::start(|_, _| {
        Some(
            Reply::json(json!([]))
                .header("link", r#"<https://evil.example.com/x?page=2>; rel="next""#),
        )
    });
    let error = server.client().pull_files(&repo(), 1).unwrap_err();
    assert_eq!(error.kind, ErrorKind::Invalid);
    assert_eq!(server.calls().len(), 1);
}

#[test]
fn decodes_a_base64_blob_to_the_exact_bytes() {
    let blob = fixture("blob-config.json");
    let (sha, size) = (
        blob["sha"].as_str().unwrap().to_owned(),
        blob["size"].as_u64().unwrap(),
    );
    let server = FakeGitHub::start(move |call, _| {
        call.path
            .contains("/git/blobs/")
            .then(|| Reply::json(blob.clone()))
    });
    let bytes = server.client().blob(&repo(), &sha).unwrap();
    assert_eq!(bytes.len() as u64, size);
    assert!(bytes.starts_with(b"import { z } from \"zod"));
}

#[test]
fn lists_a_tree_recursively() {
    let server = FakeGitHub::start(|call, _| {
        call.path
            .contains("/git/trees/")
            .then(|| Reply::json(fixture("tree.json")))
    });
    let tree = server.client().tree(&repo(), BASE).unwrap();
    assert_eq!(server.calls()[0].query["recursive"], "1");
    assert!(!tree.truncated);
    let config = tree
        .entries
        .iter()
        .find(|e| e.path == "server/src/config.ts")
        .unwrap();
    assert_eq!(config.kind, "blob");
}

#[test]
fn creates_a_pending_review_without_an_event_and_reads_its_comments_back() {
    let server = FakeGitHub::start(|call, _| match (call.method.as_str(), call.path.as_str()) {
        ("POST", "/repos/charlesabarnes/gangway/pulls/48/reviews") => Some(Reply::json(json!({
            "id": 99, "state": "PENDING",
            "html_url": "https://github.com/charlesabarnes/gangway/pull/48#pullrequestreview-99"
        }))),
        ("GET", "/repos/charlesabarnes/gangway/pulls/48/reviews/99/comments") => {
            Some(Reply::json(fixture("review-comments.json")))
        }
        _ => None,
    });
    let client = server.client();
    let input = ReviewInput {
        commit_id: HEAD.into(),
        body: String::new(),
        comments: vec![ReviewCommentInput {
            path: "server/src/config.ts".into(),
            start_line: None,
            start_side: None,
            line: 152,
            side: Side::New,
            body: "**nit:** naming".into(),
        }],
        event: None,
    };
    let review = client.create_review(&repo(), 48, &input).unwrap();
    assert_eq!((review.id, review.state.as_str()), (99, "PENDING"));
    assert!(review.html_url.contains("pullrequestreview-99"));
    assert_eq!(
        server.calls()[0].body,
        json!({
            "commit_id": HEAD,
            "body": "",
            "comments": [{ "path": "server/src/config.ts", "line": 152, "side": "RIGHT", "body": "**nit:** naming" }]
        })
    );
    let comments = client.review_comments(&repo(), 48, 99).unwrap();
    assert_eq!(comments[0].side, Some(Side::New));
}

fn failing(status: u16, headers: &[(&str, &str)], body: serde_json::Value) -> (FakeGitHub, Client) {
    let headers: Vec<(String, String)> = headers
        .iter()
        .map(|(n, v)| (n.to_string(), v.to_string()))
        .collect();
    let server = FakeGitHub::start(move |_, _| {
        let mut reply = Reply::json(body.clone()).status(status);
        for (name, value) in &headers {
            reply = reply.header(name, value.clone());
        }
        Some(reply)
    });
    let client = server.client().with_retry_wait(Duration::ZERO);
    (server, client)
}

#[test]
fn types_http_errors() {
    let (_s, c) = failing(401, &[], json!({ "message": "Bad credentials" }));
    assert_eq!(c.viewer().unwrap_err().kind, ErrorKind::BadToken);

    let (_s, c) = failing(
        403,
        &[("x-ratelimit-remaining", "4000")],
        json!({ "message": "Resource not accessible by personal access token" }),
    );
    let error = c.repo(&repo()).unwrap_err();
    assert_eq!(error.kind, ErrorKind::Forbidden);
    assert!(
        error
            .message
            .contains("Resource not accessible by personal access token")
    );

    let (_s, c) = failing(404, &[], json!({ "message": "Not Found" }));
    assert_eq!(c.repo(&repo()).unwrap_err().kind, ErrorKind::NotFound);

    let (_s, c) = failing(429, &[("retry-after", "30")], json!({}));
    assert_eq!(c.repo(&repo()).unwrap_err().kind, ErrorKind::RateLimited);

    let (_s, c) = failing(500, &[], json!({}));
    assert_eq!(c.repo(&repo()).unwrap_err().kind, ErrorKind::Server);
}

#[test]
fn reports_the_primary_rate_limit_reset() {
    let reset = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 600;
    let reset_header = reset.to_string();
    let headers = [
        ("x-ratelimit-remaining", "0"),
        ("x-ratelimit-reset", reset_header.as_str()),
    ];
    let (server, client) = failing(
        403,
        &headers,
        json!({ "message": "API rate limit exceeded" }),
    );
    let error = client.repo(&repo()).unwrap_err();
    assert_eq!(error.kind, ErrorKind::RateLimited);
    assert_eq!(
        error.reset_at,
        Some(UNIX_EPOCH + Duration::from_secs(reset))
    );
    assert_eq!(server.calls().len(), 1, "a long wait is not slept through");
}

#[test]
fn passes_validation_messages_through() {
    let (_s, c) = failing(
        422,
        &[],
        json!({ "message": "Unprocessable Entity", "errors": ["User can only have one pending review per pull request"] }),
    );
    let input = ReviewInput {
        commit_id: HEAD.into(),
        body: "x".into(),
        comments: vec![],
        event: None,
    };
    let error = c.create_review(&repo(), 48, &input).unwrap_err();
    assert_eq!(error.kind, ErrorKind::Invalid);
    assert!(error.message.contains("one pending review"));
    assert!(
        ducky_github::review::push_error_hint(&error)
            .unwrap()
            .contains("already have a pending review")
    );
}

#[test]
fn retries_a_get_once_after_a_short_secondary_limit() {
    let hits = AtomicUsize::new(0);
    let server = FakeGitHub::start(move |_, _| {
        Some(if hits.fetch_add(1, Ordering::SeqCst) == 0 {
            Reply::json(json!({ "message": "You have exceeded a secondary rate limit" }))
                .status(403)
                .header("retry-after", "0")
        } else {
            Reply::json(json!({ "login": "me" }))
        })
    });
    assert_eq!(server.client().viewer().unwrap().login, "me");
    assert_eq!(server.calls().len(), 2);
}

#[test]
fn does_not_retry_writes() {
    let (server, client) = failing(429, &[("retry-after", "0")], json!({}));
    let client = client.with_retry_wait(Duration::from_secs(2));
    let input = ReviewInput {
        commit_id: HEAD.into(),
        body: "x".into(),
        comments: vec![],
        event: None,
    };
    assert_eq!(
        client.create_review(&repo(), 1, &input).unwrap_err().kind,
        ErrorKind::RateLimited
    );
    assert_eq!(server.calls().len(), 1);
}

#[test]
fn wraps_network_failures() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let client = Client::with_base_url(Token::new("t").unwrap(), url);
    let error = client.viewer().unwrap_err();
    assert_eq!(error.kind, ErrorKind::Network);
    assert!(error.message.starts_with("Could not reach GitHub"));
}

#[test]
fn reads_graphql_errors_and_partial_data() {
    let server = FakeGitHub::start(|call, _| {
        Some(Reply::json(if call.graphql().contains("partial") {
            json!({ "data": { "ok": 1 }, "errors": [{ "type": "FORBIDDEN", "message": "no" }] })
        } else {
            json!({ "data": null, "errors": [{ "type": "FORBIDDEN", "message": "Resource not accessible by personal access token" }] })
        }))
    });
    let client = server.client();
    let partial: serde_json::Value = client
        .graphql_partial("query partial { ok }", json!({}))
        .unwrap();
    assert_eq!(partial["ok"], 1);
    let strict = client
        .graphql::<serde_json::Value>("query partial { ok }", json!({}))
        .unwrap_err();
    assert_eq!(strict.kind, ErrorKind::Forbidden);
    let error = client
        .graphql::<serde_json::Value>("query x", json!({}))
        .unwrap_err();
    assert!(error.message.contains("fine-grained token must include"));
}
