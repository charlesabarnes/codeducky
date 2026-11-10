//! A small blocking REST and GraphQL client. Each call runs on the calling thread; run it from a
//! background executor.

use std::thread;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use ureq::http::{HeaderMap, Method, Request};
use ureq::{Agent, SendBody};

use crate::error::{self, ErrorKind, GitHubError, GraphqlErrorEntry, Result};
use crate::token::Token;
use crate::url::{next_link, origin, with_query};

pub const GITHUB_API: &str = "https://api.github.com";
const API_VERSION: &str = "2022-11-28";
const JSON: &str = "application/vnd.github+json";
const USER_AGENT: &str = "codeducky";
pub(crate) const PAGE_SIZE: u32 = 100;
const MAX_PAGES: usize = 30;
const MAX_BODY_BYTES: u64 = 128 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(60);
/// A GET that hits a rate limit lifting within this long is retried once after the wait.
const DEFAULT_RETRY_WAIT: Duration = Duration::from_secs(3);

#[derive(Clone)]
pub struct Client {
    agent: Agent,
    base_url: String,
    token: Token,
    retry_wait: Duration,
    read_only: bool,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client")
            .field("base_url", &self.base_url)
            .finish_non_exhaustive()
    }
}

pub(crate) struct Response {
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }

    pub fn json<T: DeserializeOwned>(&self, what: &str) -> Result<T> {
        serde_json::from_slice(&self.body).map_err(|e| GitHubError::decode(what, e))
    }
}

#[derive(Debug, serde::Deserialize)]
struct GraphqlResponse<T> {
    data: Option<T>,
    #[serde(default)]
    errors: Vec<GraphqlErrorEntry>,
}

impl Client {
    pub fn new(token: Token) -> Self {
        Self::with_base_url(token, GITHUB_API)
    }

    /// Against another API root; tests point this at a local fake server.
    pub fn with_base_url(token: Token, base_url: impl Into<String>) -> Self {
        let config = Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(TIMEOUT))
            .user_agent(USER_AGENT)
            .build();
        Self {
            agent: Agent::new_with_config(config),
            base_url: base_url.into().trim_end_matches('/').to_owned(),
            token,
            retry_wait: DEFAULT_RETRY_WAIT,
            read_only: false,
        }
    }

    /// The longest rate-limit wait a GET sleeps through before retrying; zero turns retries off.
    pub fn with_retry_wait(mut self, wait: Duration) -> Self {
        self.retry_wait = wait;
        self
    }

    /// Refuses every write (REST calls other than GET, GraphQL mutations) before it is sent.
    pub fn read_only(mut self) -> Self {
        self.read_only = true;
        self
    }

    pub fn is_read_only(&self) -> bool {
        self.read_only
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    fn url(&self, path: &str) -> Result<String> {
        if !path.starts_with("http") {
            return Ok(format!("{}{path}", self.base_url));
        }
        // Link headers name absolute URLs; the token only ever goes to the API's own origin.
        if origin(path) == origin(&self.base_url) {
            Ok(path.to_owned())
        } else {
            Err(GitHubError::new(
                ErrorKind::Invalid,
                0,
                format!(
                    "Refusing to follow a link off the GitHub API: {}",
                    origin(path)
                ),
            ))
        }
    }

    pub(crate) fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        accept: Option<&str>,
    ) -> Result<Response> {
        if self.read_only && is_write(&method, path, body) {
            return Err(GitHubError::new(
                ErrorKind::Forbidden,
                0,
                "This connection to GitHub is read-only: the write was not sent.",
            ));
        }
        let url = self.url(path)?;
        let body = body
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|e| GitHubError::decode("request", e))?;
        let mut retried = false;
        loop {
            match self.perform(&method, &url, body.as_deref(), accept.unwrap_or(JSON)) {
                Err(error) if !retried && method == Method::GET => {
                    let wait = retry_wait(&error);
                    match wait {
                        Some(wait) if wait <= self.retry_wait => {
                            retried = true;
                            thread::sleep(wait);
                        }
                        _ => return Err(error),
                    }
                }
                other => return other,
            }
        }
    }

    fn perform(
        &self,
        method: &Method,
        url: &str,
        body: Option<&[u8]>,
        accept: &str,
    ) -> Result<Response> {
        let mut builder = Request::builder()
            .method(method.clone())
            .uri(url)
            .header("Accept", accept)
            .header("Authorization", format!("Bearer {}", self.token.expose()))
            .header("X-GitHub-Api-Version", API_VERSION);
        if body.is_some() {
            builder = builder.header("Content-Type", "application/json");
        }
        let sent = match body {
            Some(bytes) => builder.body(bytes).map(|r| self.agent.run(r)),
            None => builder.body(SendBody::none()).map(|r| self.agent.run(r)),
        }
        .map_err(GitHubError::network)?;
        let mut response = sent.map_err(GitHubError::network)?;
        let status = response.status().as_u16();
        let headers = response.headers().clone();
        let bytes = response
            .body_mut()
            .with_config()
            .limit(MAX_BODY_BYTES)
            .read_to_vec()
            .map_err(GitHubError::network)?;
        if !(200..300).contains(&status) {
            return Err(error::from_response(status, &headers, &bytes));
        }
        Ok(Response {
            headers,
            body: bytes,
        })
    }

    pub(crate) fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Response> {
        self.request(Method::GET, &with_query(path, query), None, None)
    }

    pub(crate) fn get_json<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<T> {
        self.get(path, query)?.json(path)
    }

    pub(crate) fn send_json<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: &impl Serialize,
    ) -> Result<T> {
        let body = serde_json::to_value(body).map_err(|e| GitHubError::decode("request", e))?;
        self.request(method, path, Some(&body), None)?.json(path)
    }

    /// Follows `Link: rel="next"` for at most 30 pages; `pick` takes the items out of a page.
    pub(crate) fn paginate<P: DeserializeOwned, T>(
        &self,
        path: &str,
        query: &[(&str, String)],
        pick: impl Fn(P) -> Vec<T>,
    ) -> Result<Vec<T>> {
        let mut first_query = vec![("per_page", PAGE_SIZE.to_string())];
        first_query.extend(query.iter().cloned());
        let mut next = Some(with_query(path, &first_query));
        let mut items = Vec::new();
        for _ in 0..MAX_PAGES {
            let Some(url) = next.take() else { break };
            let response = self.request(Method::GET, &url, None, None)?;
            items.extend(pick(response.json(path)?));
            next = response.header("link").and_then(next_link);
        }
        Ok(items)
    }

    pub fn graphql<T: DeserializeOwned>(&self, query: &str, variables: Value) -> Result<T> {
        self.graphql_with(query, variables, false)
    }

    /// Keeps the data when only some fields failed, e.g. a repository the token cannot see.
    pub fn graphql_partial<T: DeserializeOwned>(&self, query: &str, variables: Value) -> Result<T> {
        self.graphql_with(query, variables, true)
    }

    fn graphql_with<T: DeserializeOwned>(
        &self,
        query: &str,
        variables: Value,
        partial: bool,
    ) -> Result<T> {
        let body = serde_json::json!({ "query": query, "variables": variables });
        let response: GraphqlResponse<Value> = self
            .request(Method::POST, "/graphql", Some(&body), None)?
            .json("GraphQL response")?;
        let data = response.data.filter(|data| !data.is_null());
        if !response.errors.is_empty() && (!partial || data.is_none()) {
            return Err(error::graphql_error(&response.errors));
        }
        let data = data.ok_or_else(|| GitHubError::missing("any data"))?;
        serde_json::from_value(data).map_err(|e| GitHubError::decode("GraphQL data", e))
    }
}

fn is_write(method: &Method, path: &str, body: Option<&Value>) -> bool {
    match *method {
        Method::GET => false,
        Method::POST if path == "/graphql" => !body
            .and_then(|b| b["query"].as_str())
            .is_some_and(|query| query.trim_start().starts_with("query")),
        _ => true,
    }
}

fn retry_wait(error: &GitHubError) -> Option<Duration> {
    if !error.is(ErrorKind::RateLimited) {
        return None;
    }
    let reset = error.reset_at?;
    Some(reset.duration_since(SystemTime::now()).unwrap_or_default())
}

/// `Ok(None)` when GitHub answers with one of `statuses` (e.g. 404 for "no such branch").
pub(crate) fn or_none<T>(result: Result<T>, statuses: &[u16]) -> Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if statuses.contains(&error.status) => Ok(None),
        Err(error) => Err(error),
    }
}
