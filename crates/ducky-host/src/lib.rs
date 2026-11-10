//! One machine's commands and files, wherever that machine is.

mod local;

use std::time::Duration;

pub use local::LocalHost;

#[derive(Debug, Clone, Default)]
pub struct ExecRequest {
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
    pub stdin: Option<Vec<u8>>,
    pub timeout: Option<Duration>,
}

impl ExecRequest {
    pub fn new<I, S>(argv: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            argv: argv.into_iter().map(Into::into).collect(),
            ..Self::default()
        }
    }

    pub fn cwd(mut self, cwd: impl Into<String>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    pub fn stdin(mut self, stdin: impl Into<Vec<u8>>) -> Self {
        self.stdin = Some(stdin.into());
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecOutput {
    /// `None` when the program was ended by a signal or a timeout.
    pub status: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// The host capped stdout or stderr; the bytes here are a prefix.
    pub truncated: bool,
    pub timed_out: bool,
}

impl ExecOutput {
    pub fn success(&self) -> bool {
        self.status == Some(0) && !self.timed_out
    }
}

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("{0} is not reachable: {1}")]
    Unreachable(String, String),
    #[error("{0}: no such file")]
    NotFound(String),
    #[error("{0}")]
    Other(String),
}

/// Blocking by design: call it from a background executor, never the UI thread.
/// Paths are strings because the machine may not share this one's path rules.
pub trait Host: Send + Sync {
    /// A label for messages: `local`, or the machine's name.
    fn name(&self) -> &str;

    /// A nonzero exit or a timeout is a result, not an error.
    fn exec(&self, request: ExecRequest) -> Result<ExecOutput, HostError>;

    fn read_file(&self, path: &str) -> Result<Vec<u8>, HostError>;

    /// Creates missing parent folders and replaces the file whole.
    fn write_file(&self, path: &str, data: &[u8]) -> Result<(), HostError>;
}
