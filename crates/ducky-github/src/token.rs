use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use ducky_host::{ExecRequest, Host};

use crate::error::{ErrorKind, GitHubError, Result};

/// A GUI app on macOS does not inherit the login shell's PATH, so `gh` may only be found by its
/// usual install locations.
const GH_CANDIDATES: [&str; 4] = [
    "gh",
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    "/usr/bin/gh",
];
const GH_TIMEOUT: Duration = Duration::from_secs(10);

/// A GitHub token. Its `Debug` output is redacted and it has no `Display`, so it cannot end up in
/// a log line by accident.
#[derive(Clone, PartialEq, Eq)]
pub struct Token(String);

impl Token {
    /// `None` for an empty or blank string.
    pub fn new(value: impl Into<String>) -> Option<Self> {
        let value = value.into();
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| Self(trimmed.to_owned()))
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(***)")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenSource {
    /// `gh auth token` on this machine.
    GhCli,
    /// The token the app handed in (the PAT from the keychain).
    Fallback,
}

/// Finds a token: `gh auth token` first, then the caller's fallback. `host` must be the machine
/// the app runs on, even when the repository under review is elsewhere.
pub struct TokenProvider {
    host: Arc<dyn Host>,
    fallback: Option<Token>,
}

impl TokenProvider {
    pub fn new(local: Arc<dyn Host>) -> Self {
        Self {
            host: local,
            fallback: None,
        }
    }

    pub fn with_fallback(mut self, token: Option<Token>) -> Self {
        self.fallback = token;
        self
    }

    pub fn set_fallback(&mut self, token: Option<Token>) {
        self.fallback = token;
    }

    /// Blocking: runs `gh`. Call it off the UI thread.
    pub fn token(&self) -> Result<(Token, TokenSource)> {
        if let Some(token) = self.gh_token() {
            return Ok((token, TokenSource::GhCli));
        }
        self.fallback
            .clone()
            .map(|token| (token, TokenSource::Fallback))
            .ok_or_else(|| {
                GitHubError::new(
                    ErrorKind::NoToken,
                    0,
                    "No GitHub token. Run `gh auth login`, or add a personal access token in Settings.",
                )
            })
    }

    /// The token `gh` is logged in with for github.com, if any.
    pub fn gh_token(&self) -> Option<Token> {
        GH_CANDIDATES.iter().find_map(|gh| {
            let request = ExecRequest::new([*gh, "auth", "token", "--hostname", "github.com"])
                .timeout(GH_TIMEOUT);
            let output = self.host.exec(request).ok()?;
            if !output.success() {
                return None;
            }
            Token::new(String::from_utf8(output.stdout).ok()?)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ducky_host::{ExecOutput, HostError};
    use std::sync::Mutex;

    struct FakeHost {
        answer: Option<(i32, &'static str)>,
        calls: Mutex<Vec<Vec<String>>>,
    }

    impl Host for FakeHost {
        fn name(&self) -> &str {
            "fake"
        }

        fn exec(&self, request: ExecRequest) -> Result<ExecOutput, HostError> {
            self.calls.lock().unwrap().push(request.argv.clone());
            match self.answer {
                Some((status, stdout)) if request.argv[0] == "gh" => Ok(ExecOutput {
                    status: Some(status),
                    stdout: stdout.as_bytes().to_vec(),
                    ..ExecOutput::default()
                }),
                _ => Err(HostError::NotFound(request.argv[0].clone())),
            }
        }

        fn read_file(&self, path: &str) -> Result<Vec<u8>, HostError> {
            Err(HostError::NotFound(path.into()))
        }

        fn write_file(&self, _: &str, _: &[u8]) -> Result<(), HostError> {
            Ok(())
        }
    }

    fn provider(answer: Option<(i32, &'static str)>) -> (Arc<FakeHost>, TokenProvider) {
        let host = Arc::new(FakeHost {
            answer,
            calls: Mutex::default(),
        });
        (host.clone(), TokenProvider::new(host))
    }

    #[test]
    fn prefers_the_gh_login() {
        let (host, provider) = provider(Some((0, "gho_abc\n")));
        let provider = provider.with_fallback(Token::new("pat"));
        let (token, source) = provider.token().unwrap();
        assert_eq!(token.expose(), "gho_abc");
        assert_eq!(source, TokenSource::GhCli);
        assert_eq!(
            host.calls.lock().unwrap()[0],
            ["gh", "auth", "token", "--hostname", "github.com"]
        );
    }

    #[test]
    fn falls_back_when_gh_is_logged_out_or_missing() {
        let (_, logged_out) = provider(Some((1, "")));
        let logged_out = logged_out.with_fallback(Token::new("pat"));
        assert_eq!(logged_out.token().unwrap().1, TokenSource::Fallback);

        let (host, missing) = provider(None);
        assert_eq!(missing.token().unwrap_err().kind, ErrorKind::NoToken);
        assert_eq!(host.calls.lock().unwrap().len(), GH_CANDIDATES.len());
    }

    #[test]
    fn redacts_the_token() {
        let token = Token::new(" secret ").unwrap();
        assert_eq!(format!("{token:?}"), "Token(***)");
        assert!(Token::new("  ").is_none());
    }
}
