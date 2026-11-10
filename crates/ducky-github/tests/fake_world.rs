//! The fake world answers the client's reads the way GitHub does.

use ducky_github::ci::fetch_ci;
use ducky_github::fake::{FakeWorld, WorldOptions};
use ducky_github::inbox::fetch_inbox;
use ducky_github::pr_diff::{build_pr_changes, file_diff, load_pr_snapshot};
use ducky_github::threads::fetch_threads;
use ducky_review::{FileStats, Timestamp};

#[test]
fn serves_a_pull_request_end_to_end() {
    let world = FakeWorld::start(WorldOptions::default());
    let client = world.client();
    let repo = FakeWorld::repo();
    let snapshot = load_pr_snapshot(&client, &repo, 7).unwrap();
    assert_eq!(snapshot.merge_base_sha, world.merge_base_sha());
    let paths: Vec<&str> = snapshot.files.iter().map(|f| f.path.as_str()).collect();
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
    for file in &snapshot.files {
        file_diff(file).unwrap();
    }
    let changes = build_pr_changes(&client, &snapshot).unwrap();
    assert_eq!(changes.stats["logo.png"], FileStats::Binary);
    assert_eq!(changes.changes.len(), 5);

    let threads = fetch_threads(&client, &repo, 7).unwrap();
    assert_eq!(threads.viewer, "duckreviewer");
    assert_eq!(threads.threads.len(), 4);
    assert!(threads.pending_review.is_none());

    let ci = fetch_ci(&client, &repo, &world.head_sha())
        .unwrap()
        .unwrap();
    assert_eq!(ci.runs.len(), 3);
    assert_eq!(ci.annotations.len(), 2);

    let inbox = fetch_inbox(&client, Timestamp::now()).unwrap();
    assert_eq!(inbox.requested.len(), 2);
    assert!(inbox.requested[1].via_team);
    assert!(inbox.mine[0].draft);
    assert!(world.writes().is_empty());
}
