mod support;

use ducky_github::ci::{CiState, fetch_ci};
use ducky_github::{CheckConclusion, CheckStatus, RepoRef};
use serde_json::{Value, json};
use support::{FakeGitHub, Reply};

const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn repo() -> RepoRef {
    RepoRef::new("charlesabarnes", "codeducky")
}

fn run(id: u64, status: &str, conclusion: Option<&str>, annotations: u32) -> Value {
    json!({
        "id": id, "name": format!("job-{id}"), "status": status, "conclusion": conclusion,
        "html_url": format!("https://github.com/charlesabarnes/codeducky/runs/{id}"),
        "details_url": null, "output": { "title": null, "annotations_count": annotations },
        "app": { "name": "GitHub Actions" },
    })
}

fn annotation(path: &str, line: u32, level: &str) -> Value {
    json!({ "path": path, "start_line": line, "end_line": line, "annotation_level": level, "title": "tsc", "message": format!("problem at {line}"), "raw_details": "" })
}

#[test]
fn reads_paginated_runs_statuses_and_annotations_of_runs_that_have_any() {
    let server = FakeGitHub::start(|call, base| {
        let runs = format!("/repos/charlesabarnes/codeducky/commits/{SHA}/check-runs");
        let annotations = "/repos/charlesabarnes/codeducky/check-runs/1/annotations";
        match (call.path.as_str(), call.search.as_str()) {
            (p, "per_page=100") if p == runs => Some(
                Reply::json(json!({ "total_count": 3, "check_runs": [run(1, "completed", Some("failure"), 3), run(2, "completed", Some("success"), 0)] }))
                    .header("link", format!(r#"<{base}{runs}?per_page=100&page=2>; rel="next""#)),
            ),
            (p, "per_page=100&page=2") if p == runs => {
                Some(Reply::json(json!({ "total_count": 3, "check_runs": [run(3, "in_progress", None, 0)] })))
            }
            (p, "per_page=100") if p == annotations => Some(
                Reply::json(json!([annotation("src/a.ts", 12, "failure"), annotation(".github", 0, "failure")]))
                    .header("link", format!(r#"<{base}{annotations}?per_page=100&page=2>; rel="next""#)),
            ),
            (p, "per_page=100&page=2") if p == annotations => {
                Some(Reply::json(json!([annotation("src/a.ts", 9, "warning")])))
            }
            (p, _) if p.ends_with("/status") => Some(Reply::json(json!({
                "state": "pending",
                "statuses": [{ "context": "ci/jenkins", "state": "success", "description": "ok", "target_url": null }]
            }))),
            _ => None,
        }
    });
    let snapshot = fetch_ci(&server.client(), &repo(), SHA).unwrap().unwrap();
    let runs: Vec<(u64, CheckStatus, Option<CheckConclusion>)> = snapshot
        .runs
        .iter()
        .map(|r| (r.id, r.status, r.conclusion))
        .collect();
    assert_eq!(
        runs,
        [
            (1, CheckStatus::Completed, Some(CheckConclusion::Failure)),
            (2, CheckStatus::Completed, Some(CheckConclusion::Success)),
            (3, CheckStatus::InProgress, None),
        ]
    );
    let where_: Vec<String> = snapshot
        .annotations
        .iter()
        .map(|a| format!("{}:{}:{:?}", a.path, a.start_line, a.level))
        .collect();
    assert_eq!(
        where_,
        [
            ".github:0:Failure",
            "src/a.ts:9:Warning",
            "src/a.ts:12:Failure"
        ]
    );
    assert_eq!(snapshot.annotations[0].raw_details, None);
    assert_eq!(snapshot.statuses[0].context, "ci/jenkins");
    let summary = snapshot.summary();
    assert_eq!(
        (
            summary.state,
            summary.failed,
            summary.pending,
            summary.passed
        ),
        (CiState::Fail, 1, 1, 2)
    );
    let calls = server.calls();
    assert!(calls.iter().all(|c| c.method == "GET"));
    assert!(!calls.iter().any(|c| c.path.contains("/check-runs/2/")));
}

#[test]
fn returns_none_when_github_does_not_have_the_commit() {
    let server = FakeGitHub::start(|_, _| {
        Some(Reply::json(json!({ "message": "No commit found for SHA" })).status(422))
    });
    assert_eq!(fetch_ci(&server.client(), &repo(), SHA).unwrap(), None);
}
