//! Shared by the scratch-core tests. Each test starts its own core (`ducky_hc::scratch`), so
//! the user's live core is never involved; opt in with `cargo test -p ducky-agents -- --ignored`.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

pub const TIMEOUT: Duration = Duration::from_secs(20);

/// `python3 <fake agent>`: reports status over OSC 7501 and edits notes files.
pub fn fake_agent() -> Vec<String> {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/fake_agent.py");
    vec!["python3".into(), script.to_string_lossy().into_owned()]
}

/// A repo at `<root>/repo` on branch `feature/x`, one commit ahead of `main`.
pub fn git_repo(root: &Path) -> PathBuf {
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| {
        let output = Command::new("git")
            .args([
                "-c",
                "user.name=T",
                "-c",
                "user.email=t@x",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(&repo)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
    };
    git(&["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("README.md"), "hello\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "base"]);
    git(&["checkout", "-q", "-b", "feature/x"]);
    std::fs::write(repo.join("cart.rs"), "fn total() -> u32 { 1 }\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "cart"]);
    repo
}

/// Polls `check` until it gives a value.
pub fn eventually<T>(what: &str, mut check: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        if let Some(value) = check() {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Receives until `pick` takes an event, returning what it made of it.
pub fn receive<E: std::fmt::Debug, T>(
    rx: &flume::Receiver<E>,
    what: &str,
    mut pick: impl FnMut(&E) -> Option<T>,
) -> T {
    let deadline = Instant::now() + TIMEOUT;
    let mut seen = Vec::new();
    while let Ok(event) = rx.recv_deadline(deadline) {
        if let Some(found) = pick(&event) {
            return found;
        }
        seen.push(event);
    }
    panic!("timed out waiting for {what}; saw {seen:#?}");
}

pub fn path_str(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
