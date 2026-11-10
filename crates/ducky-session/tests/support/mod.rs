#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use ducky_host::LocalHost;
use ducky_session::{Review, ReviewRequest};

pub struct Fixture {
    _dir: tempfile::TempDir,
    pub path: PathBuf,
}

impl Fixture {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap().join("work");
        std::fs::create_dir(&path).unwrap();
        let fixture = Self { _dir: dir, path };
        fixture.git(&["init", "-q", "-b", "main"]);
        fixture
    }

    pub fn git(&self, args: &[&str]) -> String {
        let output = Command::new("git")
            .args([
                "-c",
                "user.name=Tester",
                "-c",
                "user.email=t@example.com",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.autocrlf=false",
            ])
            .args(args)
            .current_dir(&self.path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    pub fn write(&self, path: &str, content: impl AsRef<[u8]>) {
        let full = self.path.join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, content).unwrap();
    }

    pub fn commit(&self, message: &str) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", message]);
    }

    pub fn open(&self) -> Review {
        Review::open_on(
            Arc::new(LocalHost),
            ReviewRequest::local(self.path.to_str().unwrap()),
        )
        .unwrap()
    }

    pub fn notes_file(&self, branch: &str) -> PathBuf {
        let common = self.git(&["rev-parse", "--path-format=absolute", "--git-common-dir"]);
        Path::new(&common).join(format!("codeducky/branches/{branch}/notes.json"))
    }
}

pub fn numbered(prefix: &str, count: usize) -> String {
    (1..=count)
        .map(|i| format!("{prefix} line {i}\n"))
        .collect()
}
