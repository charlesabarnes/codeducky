mod support;

use std::collections::HashSet;

use ducky_github::freshness::{
    ANCESTOR_LIMIT, Freshness, check_freshness, find_github_base, pushed_ancestor,
};
use ducky_github::{ErrorKind, GitHubError, RepoRef};
use serde_json::json;
use support::{FakeGitHub, Reply};

const TIP: &str = "tttttttttttttttttttttttttttttttttttttttt";
const LOCAL_MB: &str = "llllllllllllllllllllllllllllllllllllllll";
const MERGE_BASE: &str = "mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm";

fn repo() -> RepoRef {
    RepoRef::new("me", "repo")
}

fn chain(count: usize) -> Vec<String> {
    (0..count).map(|i| format!("{i:040x}")).collect()
}

/// GitHub knows `pushed` commits, `main` at TIP, and compares to MERGE_BASE.
fn github(pushed: HashSet<String>) -> FakeGitHub {
    FakeGitHub::start(move |call, _| {
        let path = call.path.as_str();
        if let Some(sha) = path.strip_prefix("/repos/me/repo/commits/") {
            return Some(if pushed.contains(sha) {
                Reply::json(json!({ "sha": sha }))
            } else {
                Reply::json(json!({ "message": "No commit found" })).status(422)
            });
        }
        if path == "/repos/me/repo/git/ref/heads/main" {
            return Some(Reply::json(json!({ "object": { "sha": TIP } })));
        }
        if path.starts_with("/repos/me/repo/git/ref/heads/") {
            return Some(Reply::json(json!({ "message": "Not Found" })).status(404));
        }
        if path.starts_with("/repos/me/repo/compare/") {
            return Some(Reply::json(
                json!({ "status": "diverged", "ahead_by": 1, "behind_by": 1, "merge_base_commit": { "sha": MERGE_BASE } }),
            ));
        }
        None
    })
}

fn commit_calls(server: &FakeGitHub) -> usize {
    server
        .calls()
        .iter()
        .filter(|c| c.path.contains("/commits/"))
        .count()
}

#[test]
fn is_fresh_when_the_local_base_matches_github() {
    let server = github(HashSet::new());
    let fresh = check_freshness(&server.client(), &repo(), "main", TIP, "h").unwrap();
    assert_eq!(
        fresh,
        Freshness::Fresh {
            remote_tip: TIP.into()
        }
    );
    assert_eq!(commit_calls(&server), 0);
}

#[test]
fn is_stale_and_says_whether_head_is_pushed() {
    let commits = chain(1);
    let server = github(HashSet::from([commits[0].clone()]));
    let client = server.client();
    let stale = check_freshness(&client, &repo(), "main", "old", &commits[0]).unwrap();
    assert_eq!(
        stale,
        Freshness::Stale {
            local_tip: "old".into(),
            remote_tip: TIP.into(),
            head_pushed: true
        }
    );
    let unpushed = check_freshness(&client, &repo(), "main", "old", "f00d").unwrap();
    assert!(matches!(
        unpushed,
        Freshness::Stale {
            head_pushed: false,
            ..
        }
    ));
    assert_eq!(
        check_freshness(&client, &repo(), "trunk", "old", "x").unwrap(),
        Freshness::NoRemoteBranch
    );
}

#[test]
fn uses_head_with_one_request_when_it_is_pushed() {
    let commits = chain(5);
    let server = github(HashSet::from([commits[0].clone()]));
    assert_eq!(
        pushed_ancestor(&server.client(), &repo(), &commits)
            .unwrap()
            .as_ref(),
        Some(&commits[0])
    );
    assert_eq!(commit_calls(&server), 1);
}

#[test]
fn finds_an_older_pushed_commit_and_stops_after_its_batch() {
    let commits = chain(40);
    let server = github(commits[2..].iter().cloned().collect());
    assert_eq!(
        pushed_ancestor(&server.client(), &repo(), &commits)
            .unwrap()
            .as_ref(),
        Some(&commits[2])
    );
    assert!(commit_calls(&server) <= 11);
}

#[test]
fn stops_at_the_cap_and_falls_back_to_the_local_merge_base() {
    let commits = chain(80);
    let server = github(HashSet::new());
    let client = server.client();
    assert_eq!(pushed_ancestor(&client, &repo(), &commits).unwrap(), None);
    assert_eq!(commit_calls(&server), ANCESTOR_LIMIT);
    let base = find_github_base(&client, &repo(), &commits, "main", None, || {
        Ok(LOCAL_MB.into())
    })
    .unwrap();
    assert!(base.fallback);
    assert_eq!(base.pushed_sha.as_deref(), Some(LOCAL_MB));
    assert!(
        server
            .calls()
            .last()
            .unwrap()
            .path
            .ends_with(&format!("{TIP}...{LOCAL_MB}"))
    );
}

#[test]
fn passes_github_errors_on_instead_of_treating_them_as_unpushed() {
    let server = FakeGitHub::start(|_, _| {
        Some(Reply::json(json!({ "message": "Bad credentials" })).status(401))
    });
    let error = pushed_ancestor(&server.client(), &repo(), &chain(3)).unwrap_err();
    assert_eq!(error.kind, ErrorKind::BadToken);
}

#[test]
fn compares_the_github_tip_with_the_last_pushed_commit() {
    let commits = chain(4);
    let server = github(commits[2..].iter().cloned().collect());
    let base = find_github_base(&server.client(), &repo(), &commits, "main", None, || {
        Err(GitHubError::new(ErrorKind::Invalid, 0, "not needed"))
    })
    .unwrap();
    assert_eq!(
        (
            base.head_sha.as_str(),
            base.base_sha.as_str(),
            base.tip_sha.as_str()
        ),
        (commits[0].as_str(), MERGE_BASE, TIP)
    );
    assert_eq!(base.pushed_sha.as_ref(), Some(&commits[2]));
    assert_eq!(
        server.calls().last().unwrap().path,
        format!("/repos/me/repo/compare/{TIP}...{}", commits[2])
    );
}

#[test]
fn leaves_pushed_sha_out_when_head_is_pushed_and_reuses_a_known_tip() {
    let commits = chain(2);
    let server = github(HashSet::from([commits[0].clone()]));
    let base = find_github_base(
        &server.client(),
        &repo(),
        &commits,
        "main",
        Some(TIP),
        || unreachable!(),
    )
    .unwrap();
    assert_eq!(
        (base.pushed_sha, base.fallback, base.branch.as_str()),
        (None, false, "main")
    );
    assert!(!server.calls().iter().any(|c| c.path.contains("/git/ref/")));
}

#[test]
fn fails_when_github_has_no_such_base_branch() {
    let server = github(HashSet::new());
    let error = find_github_base(
        &server.client(),
        &repo(),
        &chain(2),
        "trunk",
        None,
        || unreachable!(),
    )
    .unwrap_err();
    assert!(error.message.contains("no branch named trunk"));
}
