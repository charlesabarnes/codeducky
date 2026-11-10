//! A throwaway herdr-core for tests and dev examples, never the user's live one: its own
//! `HC_SESSION`, scratch `XDG_*` dirs under a temp folder, and a cleared environment, so neither
//! the calling terminal's `HC_*` variables nor a calling agent's `CLAUDE*` ones reach the core or
//! the programs it starts. Stopped on drop.
//!
//! `HC_BIN` picks the binary; default `hc` on PATH, then `~/.local/bin/hc`.

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, Instant};

use crate::client::Client;
use crate::error::Result;

/// Passed through to the core so programs it starts find the usual tools.
const KEPT_VARS: &[&str] = &["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG"];

pub struct ScratchCore {
    dir: tempfile::TempDir,
    session: String,
    socket: PathBuf,
    env: Vec<(String, String)>,
}

pub fn hc_bin() -> PathBuf {
    if let Ok(bin) = std::env::var("HC_BIN") {
        return bin.into();
    }
    let on_path = Command::new("hc").arg("--version").output();
    if on_path.is_ok_and(|o| o.status.success()) {
        return "hc".into();
    }
    Path::new(&std::env::var("HOME").unwrap_or_default()).join(".local/bin/hc")
}

impl ScratchCore {
    /// `tag` keeps sessions of parallel tests apart; keep it short (socket paths are limited).
    pub fn start(tag: &str) -> io::Result<Self> {
        Self::start_with_env(tag, &[])
    }

    /// `env` is added to the core's own environment, which every program it starts inherits.
    pub fn start_with_env(tag: &str, env: &[(&str, &str)]) -> io::Result<Self> {
        let dir = tempfile::Builder::new().prefix("dk").tempdir_in("/tmp")?;
        let session = format!("dk{tag}{}", std::process::id() % 10_000);
        let socket = dir
            .path()
            .join("run/herdr-core")
            .join(format!("{session}.sock"));
        let core = Self {
            dir,
            session,
            socket,
            env: env
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
        };
        let status = core.hc(&["server", "status"])?;
        if !status.status.success() {
            return Err(io::Error::other(format!(
                "hc server status: {}",
                String::from_utf8_lossy(&status.stderr)
            )));
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while !core.socket.exists() {
            if Instant::now() > deadline {
                return Err(io::Error::other(format!(
                    "no socket at {}",
                    core.socket.display()
                )));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(core)
    }

    /// Runs `hc` against this core only.
    pub fn hc(&self, args: &[&str]) -> io::Result<Output> {
        self.command(args).output()
    }

    pub fn command(&self, args: &[&str]) -> Command {
        let root = self.dir.path();
        let mut command = Command::new(hc_bin());
        command.args(args).env_clear();
        for key in KEPT_VARS {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command
            .envs(self.env.iter().map(|(k, v)| (k, v)))
            .env("HC_SESSION", &self.session)
            .env("XDG_STATE_HOME", root.join("state"))
            .env("XDG_CONFIG_HOME", root.join("config"))
            .env("XDG_RUNTIME_DIR", root.join("run"))
            .env("SSH_CONNECTION", "127.0.0.1 0 127.0.0.1 0");
        command
    }

    pub fn client(&self) -> Result<Client> {
        assert!(self.socket.starts_with(self.dir.path()));
        Client::connect(&self.socket)
    }

    /// The temp folder everything of this core lives in; free for test files too.
    pub fn root(&self) -> &Path {
        self.dir.path()
    }

    pub fn socket(&self) -> &Path {
        &self.socket
    }

    pub fn session(&self) -> &str {
        &self.session
    }

    /// `templates/<name>.md` in here are this core's templates.
    pub fn config_dir(&self) -> PathBuf {
        self.dir.path().join("config/herdr-core")
    }

    pub fn stop(&self) {
        let _ = self.hc(&["server", "stop"]);
    }
}

impl Drop for ScratchCore {
    fn drop(&mut self) {
        self.stop();
    }
}
