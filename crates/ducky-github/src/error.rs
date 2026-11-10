use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use ureq::http::HeaderMap;

/// GitHub asks clients that hit a secondary limit without a `retry-after` to wait a minute.
const SECONDARY_WAIT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// No `gh` login and no token handed in.
    NoToken,
    /// 401: wrong, expired or revoked.
    BadToken,
    Forbidden,
    NotFound,
    RateLimited,
    /// 409/422 and GraphQL validation errors: GitHub understood and refused.
    Invalid,
    Server,
    /// No response: DNS, TLS, connection, timeout.
    Network,
    /// A response this crate could not read.
    Decode,
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct GitHubError {
    pub kind: ErrorKind,
    /// The HTTP status; 0 when no response came back.
    pub status: u16,
    pub message: String,
    /// When a rate limit lifts.
    pub reset_at: Option<SystemTime>,
}

pub type Result<T, E = GitHubError> = std::result::Result<T, E>;

impl GitHubError {
    pub fn new(kind: ErrorKind, status: u16, message: impl Into<String>) -> Self {
        Self {
            kind,
            status,
            message: message.into(),
            reset_at: None,
        }
    }

    pub fn is(&self, kind: ErrorKind) -> bool {
        self.kind == kind
    }

    pub(crate) fn network(reason: impl std::fmt::Display) -> Self {
        Self::new(
            ErrorKind::Network,
            0,
            format!("Could not reach GitHub: {reason}"),
        )
    }

    pub(crate) fn decode(what: &str, reason: impl std::fmt::Display) -> Self {
        Self::new(
            ErrorKind::Decode,
            0,
            format!("Could not read GitHub's {what}: {reason}"),
        )
    }

    pub(crate) fn missing(what: impl std::fmt::Display) -> Self {
        Self::new(
            ErrorKind::Invalid,
            0,
            format!("GitHub did not return {what}."),
        )
    }
}

#[derive(Debug, Default, Deserialize)]
struct ErrorBody {
    message: Option<String>,
    #[serde(default)]
    errors: Vec<ErrorDetail>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ErrorDetail {
    Text(String),
    Object {
        message: Option<String>,
        code: Option<String>,
    },
}

impl ErrorBody {
    fn parse(body: &[u8]) -> Self {
        serde_json::from_slice(body).unwrap_or_default()
    }

    fn parts(&self) -> Vec<&str> {
        self.message
            .as_deref()
            .into_iter()
            .chain(self.errors.iter().filter_map(|error| match error {
                ErrorDetail::Text(text) => Some(text.as_str()),
                ErrorDetail::Object { message, code } => message.as_deref().or(code.as_deref()),
            }))
            .filter(|part| !part.is_empty())
            .collect()
    }

    fn detail(&self) -> String {
        let parts = self.parts();
        if parts.is_empty() {
            String::new()
        } else {
            format!(" GitHub said: {}", parts.join("; "))
        }
    }

    fn mentions_secondary_limit(&self) -> bool {
        self.parts()
            .iter()
            .any(|part| part.to_ascii_lowercase().contains("secondary rate limit"))
    }
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn rate_limit_reset(headers: &HeaderMap, now: SystemTime) -> Option<SystemTime> {
    if let Some(seconds) = header(headers, "retry-after").and_then(|v| v.trim().parse::<u64>().ok())
    {
        return Some(now + Duration::from_secs(seconds));
    }
    if header(headers, "x-ratelimit-remaining") == Some("0") {
        let reset = header(headers, "x-ratelimit-reset")?
            .trim()
            .parse::<u64>()
            .ok()?;
        return Some(UNIX_EPOCH + Duration::from_secs(reset));
    }
    None
}

fn wait_label(reset_at: SystemTime, now: SystemTime) -> String {
    let seconds = reset_at.duration_since(now).unwrap_or_default().as_secs();
    if seconds < 90 {
        format!("{seconds} s")
    } else {
        format!("{} min", seconds.div_ceil(60))
    }
}

/// The typed error for a failed REST response (any non-2xx status).
pub(crate) fn from_response(status: u16, headers: &HeaderMap, body: &[u8]) -> GitHubError {
    from_response_at(status, headers, body, SystemTime::now())
}

pub(crate) fn from_response_at(
    status: u16,
    headers: &HeaderMap,
    body: &[u8],
    now: SystemTime,
) -> GitHubError {
    let parsed = ErrorBody::parse(body);
    if status == 403 || status == 429 {
        let reset = rate_limit_reset(headers, now).or_else(|| {
            (status == 429 || parsed.mentions_secondary_limit()).then_some(now + SECONDARY_WAIT)
        });
        if let Some(reset_at) = reset {
            return GitHubError {
                kind: ErrorKind::RateLimited,
                status,
                message: format!(
                    "GitHub rate limit reached. Try again in {}.",
                    wait_label(reset_at, now)
                ),
                reset_at: Some(reset_at),
            };
        }
    }
    let detail = parsed.detail();
    match status {
        401 => GitHubError::new(
            ErrorKind::BadToken,
            status,
            "GitHub rejected the token (401): it may be wrong, expired or revoked. \
             Run `gh auth login`, or check the token in Settings.",
        ),
        403 => GitHubError::new(
            ErrorKind::Forbidden,
            status,
            format!(
                "GitHub refused access (403). The token is missing a permission for this \
                 repository (fine-grained tokens need Contents: read and Pull requests: read \
                 and write).{detail}"
            ),
        ),
        404 => GitHubError::new(
            ErrorKind::NotFound,
            status,
            "Not found on GitHub (404). The repository, branch or pull request does not exist, \
             or the token cannot see it (a fine-grained token must include this repository).",
        ),
        409 | 422 => GitHubError::new(
            ErrorKind::Invalid,
            status,
            format!("GitHub rejected the request ({status}).{detail}"),
        ),
        _ => GitHubError::new(
            if status >= 500 {
                ErrorKind::Server
            } else {
                ErrorKind::Invalid
            },
            status,
            format!("GitHub returned an error ({status}).{detail}"),
        ),
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct GraphqlErrorEntry {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub message: Option<String>,
}

/// The GraphQL error types GitHub sends, mapped onto the REST error kinds.
pub(crate) fn graphql_error(errors: &[GraphqlErrorEntry]) -> GitHubError {
    let text = errors
        .iter()
        .filter_map(|error| error.message.as_deref())
        .filter(|message| !message.is_empty())
        .collect::<Vec<_>>()
        .join("; ");
    match errors.first().and_then(|error| error.kind.as_deref()) {
        Some("NOT_FOUND") => GitHubError::new(
            ErrorKind::NotFound,
            404,
            format!("Not found on GitHub. {text}"),
        ),
        Some("FORBIDDEN") => GitHubError::new(
            ErrorKind::Forbidden,
            403,
            format!(
                "GitHub refused access. {text} A fine-grained token must include this \
                 repository, with Pull requests: read and write."
            ),
        ),
        Some("RATE_LIMITED") => {
            let mut error = GitHubError::new(
                ErrorKind::RateLimited,
                403,
                format!("GitHub rate limit reached. {text}"),
            );
            error.reset_at = Some(SystemTime::now() + SECONDARY_WAIT);
            error
        }
        _ if text
            .to_ascii_lowercase()
            .contains("not accessible by personal access")
            || text
                .to_ascii_lowercase()
                .contains("not accessible by integration") =>
        {
            GitHubError::new(
                ErrorKind::Forbidden,
                403,
                format!("GitHub refused access. {text}"),
            )
        }
        _ => GitHubError::new(
            ErrorKind::Invalid,
            422,
            format!("GitHub rejected the request. {text}"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ureq::http::HeaderValue;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    const NOW: Duration = Duration::from_secs(1_800_000_000);

    fn at(status: u16, pairs: &[(&'static str, &str)], body: &str) -> GitHubError {
        from_response_at(status, &headers(pairs), body.as_bytes(), UNIX_EPOCH + NOW)
    }

    #[test]
    fn bad_token_on_401() {
        let error = at(401, &[], r#"{"message":"Bad credentials"}"#);
        assert_eq!(error.kind, ErrorKind::BadToken);
        assert!(error.message.contains("token"));
    }

    #[test]
    fn missing_permission_on_403_with_github_detail() {
        let error = at(
            403,
            &[("x-ratelimit-remaining", "4000")],
            r#"{"message":"Resource not accessible by personal access token"}"#,
        );
        assert_eq!(error.kind, ErrorKind::Forbidden);
        assert!(error.message.contains("permission"));
        assert!(
            error
                .message
                .contains("Resource not accessible by personal access token")
        );
    }

    #[test]
    fn not_found_on_404() {
        let error = at(404, &[], r#"{"message":"Not Found"}"#);
        assert_eq!(error.kind, ErrorKind::NotFound);
        assert!(error.message.contains("repository"));
    }

    #[test]
    fn primary_rate_limit_carries_the_reset_time() {
        let reset = NOW.as_secs() + 600;
        let error = at(
            403,
            &[
                ("x-ratelimit-remaining", "0"),
                ("x-ratelimit-reset", &reset.to_string()),
            ],
            r#"{"message":"API rate limit exceeded"}"#,
        );
        assert_eq!(error.kind, ErrorKind::RateLimited);
        assert_eq!(
            error.reset_at,
            Some(UNIX_EPOCH + Duration::from_secs(reset))
        );
        assert!(error.message.contains("10 min"));
    }

    #[test]
    fn secondary_rate_limit_from_retry_after() {
        let error = at(429, &[("retry-after", "30")], "{}");
        assert_eq!(error.kind, ErrorKind::RateLimited);
        assert_eq!(
            error.reset_at,
            Some(UNIX_EPOCH + NOW + Duration::from_secs(30))
        );
    }

    #[test]
    fn secondary_rate_limit_from_the_message_alone() {
        let error = at(
            403,
            &[],
            r#"{"message":"You have exceeded a secondary rate limit. Please wait."}"#,
        );
        assert_eq!(error.kind, ErrorKind::RateLimited);
        assert_eq!(error.reset_at, Some(UNIX_EPOCH + NOW + SECONDARY_WAIT));
    }

    #[test]
    fn validation_messages_pass_through_on_422() {
        let error = at(
            422,
            &[],
            r#"{"message":"Unprocessable Entity","errors":["User can only have one pending review per pull request",{"code":"custom","message":"x"}]}"#,
        );
        assert_eq!(error.kind, ErrorKind::Invalid);
        assert!(error.message.contains("one pending review"));
    }

    #[test]
    fn server_errors_and_unreadable_bodies() {
        let error = at(502, &[], "<html>bad gateway</html>");
        assert_eq!(error.kind, ErrorKind::Server);
        assert_eq!(error.message, "GitHub returned an error (502).");
    }

    #[test]
    fn graphql_error_types() {
        let entry = |kind: Option<&str>, message: &str| GraphqlErrorEntry {
            kind: kind.map(str::to_owned),
            message: Some(message.to_owned()),
        };
        assert_eq!(
            graphql_error(&[entry(Some("NOT_FOUND"), "x")]).kind,
            ErrorKind::NotFound
        );
        let forbidden = graphql_error(&[entry(Some("FORBIDDEN"), "Resource not accessible")]);
        assert_eq!(forbidden.kind, ErrorKind::Forbidden);
        assert!(
            forbidden
                .message
                .contains("fine-grained token must include")
        );
        assert_eq!(
            graphql_error(&[entry(Some("RATE_LIMITED"), "slow down")]).kind,
            ErrorKind::RateLimited
        );
        assert_eq!(
            graphql_error(&[entry(None, "Resource not accessible by integration")]).kind,
            ErrorKind::Forbidden
        );
        assert_eq!(
            graphql_error(&[entry(None, "Bad field")]).kind,
            ErrorKind::Invalid
        );
    }
}
