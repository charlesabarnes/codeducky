//! Runs `git` on the host with output shapes pinned, whatever the user's config says.

use std::sync::Arc;
use std::time::Duration;

use ducky_host::{ExecOutput, ExecRequest, Host, HostError};

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);

/// Settings that change what porcelain prints; ours win over the user's.
const CONFIG: &[&str] = &[
    "core.quotepath=off",
    "color.ui=false",
    "core.pager=cat",
    "diff.noprefix=false",
    "diff.mnemonicPrefix=false",
    "diff.suppressBlankEmpty=false",
    "diff.relative=false",
    "log.showSignature=false",
    "i18n.logOutputEncoding=UTF-8",
];

const ENV: &[(&str, &str)] = &[
    ("LC_ALL", "C"),
    ("LANG", "C"),
    ("LANGUAGE", "C"),
    ("GIT_OPTIONAL_LOCKS", "0"),
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GIT_PAGER", "cat"),
    ("GIT_LITERAL_PATHSPECS", "1"),
];

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error(transparent)]
    Host(#[from] HostError),
    #[error("{path} is not in a git repository")]
    NotARepository { path: String },
    #[error("{path} is a bare repository; open a worktree")]
    Bare { path: String },
    #[error("git {command} failed ({status:?}): {stderr}")]
    Failed {
        command: String,
        status: Option<i32>,
        stderr: String,
    },
    #[error("git {command} timed out")]
    TimedOut { command: String },
    /// Output passed the host's cap (8 MiB through herdr-core).
    #[error("git {command} printed more than the host passes back")]
    TooLarge { command: String },
    #[error("git {command}: unexpected output: {detail}")]
    Parse { command: String, detail: String },
}

pub type Result<T, E = GitError> = std::result::Result<T, E>;

/// A git command line bound to one host and working directory.
#[derive(Clone)]
pub(crate) struct Runner {
    pub host: Arc<dyn Host>,
    pub cwd: String,
    pub timeout: Duration,
}

impl Runner {
    pub fn new(host: Arc<dyn Host>, cwd: impl Into<String>) -> Self {
        Self {
            host,
            cwd: cwd.into(),
            timeout: DEFAULT_TIMEOUT,
        }
    }

    fn request(&self, args: &[&str], stdin: Option<Vec<u8>>) -> ExecRequest {
        let mut argv = vec!["git".to_owned()];
        for setting in CONFIG {
            argv.push("-c".into());
            argv.push((*setting).into());
        }
        argv.extend(args.iter().map(|a| (*a).to_owned()));
        let mut request = ExecRequest::new(argv)
            .cwd(self.cwd.clone())
            .timeout(self.timeout);
        request.env = ENV
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        request.stdin = stdin;
        request
    }

    /// Whatever it exits with; only host failures and timeouts are errors.
    pub fn output(&self, args: &[&str], stdin: Option<Vec<u8>>) -> Result<ExecOutput> {
        let output = self.host.exec(self.request(args, stdin))?;
        if output.timed_out {
            return Err(GitError::TimedOut {
                command: describe(args),
            });
        }
        Ok(output)
    }

    /// Stdout of a command that must exit 0 and fit the host's cap.
    pub fn run(&self, args: &[&str]) -> Result<Vec<u8>> {
        self.run_with(args, None)
    }

    pub fn run_with(&self, args: &[&str], stdin: Option<Vec<u8>>) -> Result<Vec<u8>> {
        let output = self.output(args, stdin)?;
        self.expect(args, output, &[0])
    }

    /// Stdout when the exit code is one of `ok`; `None` for exit 1 when 1 means "no".
    pub fn expect(&self, args: &[&str], output: ExecOutput, ok: &[i32]) -> Result<Vec<u8>> {
        match output.status {
            Some(code) if ok.contains(&code) => {
                if output.truncated {
                    return Err(GitError::TooLarge {
                        command: describe(args),
                    });
                }
                Ok(output.stdout)
            }
            status => Err(failed(args, status, &output.stderr)),
        }
    }

    /// Stdout on exit 0, `None` on exit 1 (git's "not found" / "no"), an error otherwise.
    pub fn run_maybe(&self, args: &[&str]) -> Result<Option<Vec<u8>>> {
        let output = self.output(args, None)?;
        if output.status == Some(1) {
            return Ok(None);
        }
        self.expect(args, output, &[0]).map(Some)
    }
}

pub(crate) fn failed(args: &[&str], status: Option<i32>, stderr: &[u8]) -> GitError {
    GitError::Failed {
        command: describe(args),
        status,
        stderr: String::from_utf8_lossy(stderr).trim().to_owned(),
    }
}

pub(crate) fn describe(args: &[&str]) -> String {
    args.iter()
        .take_while(|a| **a != "--")
        .take(4)
        .copied()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn parse_error(args: &[&str], detail: impl Into<String>) -> GitError {
    GitError::Parse {
        command: describe(args),
        detail: detail.into(),
    }
}

pub(crate) fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// One line of output, without its newline.
pub(crate) fn line(bytes: &[u8]) -> String {
    text(bytes).trim_end_matches(['\n', '\r']).to_owned()
}
