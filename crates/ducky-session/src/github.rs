//! Signing in to GitHub and describing the connection for the UI.

use std::time::SystemTime;

use ducky_github::{Client, ErrorKind, GITHUB_API, GitHubError, Token, TokenSource, Viewer};

/// Where the token came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenOrigin {
    /// `gh auth token`.
    GhCli,
    /// The personal access token saved in the keychain.
    Saved,
    /// A dev run's fake GitHub.
    Fake,
}

impl From<TokenSource> for TokenOrigin {
    fn from(source: TokenSource) -> Self {
        match source {
            TokenSource::GhCli => Self::GhCli,
            TokenSource::Fallback => Self::Saved,
        }
    }
}

impl TokenOrigin {
    pub fn label(self) -> &'static str {
        match self {
            Self::GhCli => "gh login",
            Self::Saved => "saved token",
            Self::Fake => "fake GitHub",
        }
    }
}

/// A working connection: the client and who it is.
#[derive(Debug, Clone)]
pub struct GitHubLogin {
    pub client: Client,
    pub viewer: Viewer,
    pub origin: TokenOrigin,
}

impl GitHubLogin {
    /// A classic token without the `repo` scope cannot see private repositories or write
    /// reviews; fine-grained and `gh` tokens do not list scopes, so they are not judged here.
    pub fn scope_problem(&self) -> Option<&'static str> {
        let scopes = self.viewer.scopes.as_ref()?;
        let enough = scopes.iter().any(|s| s == "repo" || s == "public_repo");
        (!enough).then_some(ducky_github::inbox::TOKEN_SCOPE_HINT)
    }
}

/// Blocking: one `GET /user` to check the token. `read_only` refuses writes in the client.
pub fn sign_in(
    token: Token,
    origin: TokenOrigin,
    base_url: Option<&str>,
    read_only: bool,
) -> Result<GitHubLogin, GitHubError> {
    let client = Client::with_base_url(token, base_url.unwrap_or(GITHUB_API));
    let client = if read_only {
        client.read_only()
    } else {
        client
    };
    let viewer = client.viewer()?;
    Ok(GitHubLogin {
        client,
        viewer,
        origin,
    })
}

/// What the UI says about GitHub.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitHubStatus {
    /// Not looked at yet: nothing has needed GitHub.
    Unchecked,
    Checking,
    SignedIn {
        login: String,
        origin: TokenOrigin,
        scope_hint: Option<String>,
    },
    SignedOut {
        reason: String,
    },
    RateLimited {
        reset_at: Option<SystemTime>,
        message: String,
    },
    Failed {
        message: String,
    },
}

impl GitHubStatus {
    pub fn from_login(login: &GitHubLogin) -> Self {
        Self::SignedIn {
            login: login.viewer.login.clone(),
            origin: login.origin,
            scope_hint: login.scope_problem().map(str::to_owned),
        }
    }

    pub fn from_error(error: &GitHubError) -> Self {
        match error.kind {
            ErrorKind::NoToken | ErrorKind::BadToken => Self::SignedOut {
                reason: error.message.clone(),
            },
            ErrorKind::RateLimited => Self::RateLimited {
                reset_at: error.reset_at,
                message: error.message.clone(),
            },
            _ => Self::Failed {
                message: error.message.clone(),
            },
        }
    }

    /// One line for the title bar.
    pub fn label(&self, now: SystemTime) -> String {
        match self {
            Self::Unchecked => "GitHub: not checked".into(),
            Self::Checking => "GitHub: checking…".into(),
            Self::SignedIn {
                login, scope_hint, ..
            } => match scope_hint {
                Some(_) => format!("GitHub: {login} (missing scopes)"),
                None => format!("GitHub: {login}"),
            },
            Self::SignedOut { .. } => "GitHub: signed out".into(),
            Self::RateLimited { reset_at, .. } => match reset_at {
                Some(at) => format!(
                    "GitHub: rate limited, {}",
                    reset_in(at.duration_since(now).unwrap_or_default().as_secs())
                ),
                None => "GitHub: rate limited".into(),
            },
            Self::Failed { .. } => "GitHub: unreachable".into(),
        }
    }

    pub fn is_signed_in(&self) -> bool {
        matches!(self, Self::SignedIn { .. })
    }
}

fn reset_in(seconds: u64) -> String {
    if seconds < 90 {
        format!("resets in {seconds} s")
    } else {
        format!("resets in {} min", seconds.div_ceil(60))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn labels_each_state() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1000);
        let limited = GitHubStatus::RateLimited {
            reset_at: Some(now + Duration::from_secs(600)),
            message: String::new(),
        };
        assert_eq!(limited.label(now), "GitHub: rate limited, resets in 10 min");
        let error = GitHubError::new(ErrorKind::BadToken, 401, "bad");
        assert!(matches!(
            GitHubStatus::from_error(&error),
            GitHubStatus::SignedOut { .. }
        ));
    }
}
