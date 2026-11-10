#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use ducky_git::Repo;
use ducky_host::{ExecOutput, ExecRequest, Host, HostError, LocalHost};

/// Config that would break parsing if the crate relied on the user's settings.
const HOSTILE: &[(&str, &str)] = &[
    ("diff.noprefix", "true"),
    ("diff.mnemonicPrefix", "true"),
    ("color.ui", "always"),
    ("color.diff", "always"),
    ("core.quotepath", "true"),
    ("diff.renames", "false"),
    ("diff.context", "10"),
    ("diff.algorithm", "patience"),
    ("diff.relative", "true"),
    ("log.decorate", "full"),
    ("format.pretty", "oneline"),
    ("status.showUntrackedFiles", "no"),
];

pub struct TestRepo {
    pub dir: tempfile::TempDir,
    pub path: PathBuf,
}

impl TestRepo {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap().join("work");
        std::fs::create_dir(&path).unwrap();
        let repo = Self { dir, path };
        repo.git(&["init", "-q", "-b", "main"]);
        repo.harden();
        repo
    }

    pub fn harden(&self) {
        for (key, value) in HOSTILE {
            self.git(&["config", key, value]);
        }
    }

    pub fn git_in(dir: &Path, args: &[&str]) -> String {
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
                "-c",
                "protocol.file.allow=always",
                "-c",
                "init.defaultBranch=main",
            ])
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_DATE", "2026-01-02T03:04:05Z")
            .env("GIT_COMMITTER_DATE", "2026-01-02T03:04:05Z")
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?}: {output:?}");
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    pub fn git(&self, args: &[&str]) -> String {
        Self::git_in(&self.path, args)
    }

    pub fn write(&self, path: &str, bytes: impl AsRef<[u8]>) {
        let full = self.path.join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, bytes).unwrap();
    }

    pub fn commit_all(&self, message: &str) -> String {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "--allow-empty", "-m", message]);
        self.git(&["rev-parse", "HEAD"])
    }

    pub fn open(&self) -> Repo {
        Repo::open(Arc::new(LocalHost), self.path.to_str().unwrap()).unwrap()
    }

    pub fn open_with(&self, host: Arc<dyn Host>) -> Repo {
        Repo::open(host, self.path.to_str().unwrap()).unwrap()
    }
}

/// Keeps the first `cap` bytes of stdout, as herdr-core does at 8 MiB.
pub struct CappedHost(pub usize);

impl Host for CappedHost {
    fn name(&self) -> &str {
        "capped"
    }

    fn exec(&self, request: ExecRequest) -> Result<ExecOutput, HostError> {
        let mut output = LocalHost.exec(request)?;
        if output.stdout.len() > self.0 {
            output.stdout.truncate(self.0);
            output.truncated = true;
        }
        Ok(output)
    }

    fn read_file(&self, path: &str) -> Result<Vec<u8>, HostError> {
        LocalHost.read_file(path)
    }

    fn write_file(&self, path: &str, data: &[u8]) -> Result<(), HostError> {
        LocalHost.write_file(path, data)
    }
}
