//! Read-only checks against the real GitHub API with the local `gh` login. Opt in:
//! `cargo test -p ducky-github --test live -- --ignored --nocapture`
//! Only GET requests and GraphQL queries; nothing is created, changed or deleted.

use std::sync::Arc;

use ducky_github::ci::fetch_ci;
use ducky_github::inbox::fetch_inbox;
use ducky_github::pr_diff::{build_pr_changes, file_diff, load_pr_snapshot};
use ducky_github::reviewers::reviewer_states;
use ducky_github::threads::fetch_threads;
use ducky_github::{Client, RepoRef, TokenProvider};
use ducky_host::LocalHost;
use ducky_review::Timestamp;

fn client() -> Client {
    let (token, source) = TokenProvider::new(Arc::new(LocalHost))
        .token()
        .expect("a gh login");
    println!("token from {source:?}");
    Client::new(token)
}

#[test]
#[ignore = "talks to api.github.com"]
fn reads_charlesabarnes_codeducky() {
    let client = client();
    let repo = RepoRef::new("charlesabarnes", "codeducky");

    let viewer = client.viewer().unwrap();
    println!("viewer {} scopes {:?}", viewer.login, viewer.scopes);
    let summary = client.repo(&repo).unwrap();
    println!(
        "repo {} default {}",
        summary.full_name, summary.default_branch
    );
    let tip = client
        .branch_head(&repo, &summary.default_branch)
        .unwrap()
        .unwrap();
    assert!(client.commit_exists(&repo, &tip).unwrap());

    let inbox = fetch_inbox(&client, Timestamp::now()).unwrap();
    println!("inbox totals {:?}", inbox.totals);

    let number = std::env::var("DUCKY_LIVE_PR")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(32);
    let snapshot = load_pr_snapshot(&client, &repo, number).unwrap();
    println!(
        "#{number} {:?} {} files, merge base {}",
        snapshot.pull.state,
        snapshot.files.len(),
        &snapshot.merge_base_sha[..7]
    );
    assert!(!snapshot.files.is_empty());
    for file in &snapshot.files {
        file_diff(file).unwrap_or_else(|e| panic!("{}: {e}", file.path));
    }
    let changes = build_pr_changes(&client, &snapshot).unwrap();
    assert_eq!(changes.changes.len(), snapshot.files.len());

    let commits = client.pull_commits(&repo, number).unwrap();
    let reviews = client.pull_reviews(&repo, number).unwrap();
    let conversation = client.issue_comments(&repo, number).unwrap();
    println!(
        "{} commits, {} reviews, {} comments, reviewers {:?}",
        commits.len(),
        reviews.len(),
        conversation.len(),
        reviewer_states(&snapshot.pull, &reviews)
    );

    let threads = fetch_threads(&client, &repo, number).unwrap();
    println!(
        "{} threads, pending review: {}",
        threads.threads.len(),
        threads.pending_review.is_some()
    );

    for sha in [&snapshot.pull.pr.head_sha, &tip] {
        let Some(ci) = fetch_ci(&client, &repo, sha).unwrap() else {
            continue;
        };
        println!(
            "CI on {}: {:?}, {} runs, {} statuses, {} annotations",
            &sha[..7],
            ci.summary().state,
            ci.runs.len(),
            ci.statuses.len(),
            ci.annotations.len()
        );
    }
}
