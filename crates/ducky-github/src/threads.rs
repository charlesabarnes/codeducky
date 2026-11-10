//! Review threads on a pull request: read, reply, resolve, and add to a pending review.

use std::collections::{BTreeMap, HashMap};

use ducky_review::Side;
use serde::Deserialize;
use serde_json::json;

use crate::api::reviews::{github_side, side_from_github};
use crate::client::Client;
use crate::error::{ErrorKind, GitHubError, Result};
use crate::remote::RepoRef;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadComment {
    pub id: String,
    pub database_id: Option<u64>,
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub url: String,
    /// Part of your pending review: only you see it until the review is submitted.
    pub pending: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewThread {
    pub id: String,
    pub path: String,
    /// The line on `side` at the PR head (new) or merge base (old); `None` when outdated.
    pub line: Option<u32>,
    pub original_line: Option<u32>,
    pub start_line: Option<u32>,
    pub side: Side,
    pub file_level: bool,
    pub is_resolved: bool,
    pub is_outdated: bool,
    pub resolved_by: Option<String>,
    pub can_reply: bool,
    pub can_resolve: bool,
    pub can_unresolve: bool,
    pub comments: Vec<ThreadComment>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingReview {
    /// GraphQL node id, for adding threads.
    pub id: String,
    /// REST id, for submitting and editing the body.
    pub database_id: Option<u64>,
    pub body: String,
    pub comments: u32,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullThreads {
    pub pull_id: String,
    pub viewer: String,
    pub threads: Vec<ReviewThread>,
    /// Yours, if you have one: GitHub allows one pending review per person per pull request.
    pub pending_review: Option<PendingReview>,
}

const COMMENT_FIELDS: &str = "id databaseId body createdAt url state author { login }";
const MAX_THREAD_PAGES: usize = 20;

fn threads_query() -> String {
    format!(
        "query Threads($owner: String!, $name: String!, $number: Int!, $after: String) {{
  viewer {{ login }}
  repository(owner: $owner, name: $name) {{
    pullRequest(number: $number) {{
      id
      pending: reviews(states: PENDING, first: 1) {{ nodes {{ id databaseId body url comments {{ totalCount }} }} }}
      reviewThreads(first: 50, after: $after) {{
        pageInfo {{ hasNextPage endCursor }}
        nodes {{
          id path line originalLine startLine diffSide subjectType isResolved isOutdated
          viewerCanReply viewerCanResolve viewerCanUnresolve
          resolvedBy {{ login }}
          comments(first: 100) {{ nodes {{ {COMMENT_FIELDS} }} }}
        }}
      }}
    }}
  }}
}}"
    )
}

#[derive(Deserialize)]
struct Login {
    login: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RawComment {
    id: String,
    database_id: Option<u64>,
    body: String,
    created_at: String,
    url: String,
    state: Option<String>,
    author: Option<Login>,
}

impl From<RawComment> for ThreadComment {
    fn from(raw: RawComment) -> Self {
        Self {
            id: raw.id,
            database_id: raw.database_id,
            author: raw.author.map_or_else(|| "ghost".into(), |a| a.login),
            body: raw.body,
            created_at: raw.created_at,
            url: raw.url,
            pending: raw.state.as_deref() == Some("PENDING"),
        }
    }
}

#[derive(Deserialize)]
struct Nodes<T> {
    nodes: Vec<Option<T>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RawThread {
    id: String,
    path: String,
    line: Option<u32>,
    original_line: Option<u32>,
    start_line: Option<u32>,
    diff_side: Option<String>,
    subject_type: Option<String>,
    is_resolved: bool,
    is_outdated: bool,
    viewer_can_reply: Option<bool>,
    viewer_can_resolve: Option<bool>,
    viewer_can_unresolve: Option<bool>,
    resolved_by: Option<Login>,
    comments: Nodes<RawComment>,
}

impl From<RawThread> for ReviewThread {
    fn from(raw: RawThread) -> Self {
        Self {
            id: raw.id,
            path: raw.path,
            line: if raw.is_outdated { None } else { raw.line },
            original_line: raw.original_line,
            start_line: raw.start_line,
            side: side_from_github(raw.diff_side.as_deref().unwrap_or("RIGHT")),
            file_level: raw.subject_type.as_deref() == Some("FILE"),
            is_resolved: raw.is_resolved,
            is_outdated: raw.is_outdated,
            resolved_by: raw.resolved_by.map(|l| l.login),
            can_reply: raw.viewer_can_reply.unwrap_or(true),
            can_resolve: raw.viewer_can_resolve.unwrap_or(false),
            can_unresolve: raw.viewer_can_unresolve.unwrap_or(false),
            comments: raw
                .comments
                .nodes
                .into_iter()
                .flatten()
                .map(Into::into)
                .collect(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPending {
    id: String,
    database_id: Option<u64>,
    body: Option<String>,
    url: Option<String>,
    comments: Option<Count>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Count {
    total_count: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawThreadPage {
    page_info: PageInfo,
    nodes: Vec<Option<RawThread>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPull {
    id: String,
    pending: Nodes<RawPending>,
    review_threads: RawThreadPage,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRepository {
    pull_request: Option<RawPull>,
}

#[derive(Deserialize)]
struct RawThreads {
    viewer: Login,
    repository: Option<RawRepository>,
}

pub fn fetch_threads(client: &Client, repo: &RepoRef, number: u64) -> Result<PullThreads> {
    let query = threads_query();
    let mut after: Option<String> = None;
    let mut result: Option<PullThreads> = None;
    for _ in 0..MAX_THREAD_PAGES {
        let raw: RawThreads = client.graphql(
            &query,
            json!({ "owner": repo.owner, "name": repo.name, "number": number, "after": after }),
        )?;
        let pull = raw.repository.and_then(|r| r.pull_request).ok_or_else(|| {
            GitHubError::new(
                ErrorKind::NotFound,
                404,
                format!("Pull request #{number} was not found in {repo}."),
            )
        })?;
        let threads = pull
            .review_threads
            .nodes
            .into_iter()
            .flatten()
            .map(ReviewThread::from);
        let state = result.get_or_insert_with(|| PullThreads {
            pull_id: pull.id,
            viewer: raw.viewer.login,
            threads: Vec::new(),
            pending_review: pull.pending.nodes.into_iter().flatten().next().map(|p| {
                PendingReview {
                    id: p.id,
                    database_id: p.database_id,
                    body: p.body.unwrap_or_default(),
                    comments: p.comments.map_or(0, |c| c.total_count),
                    url: p.url.unwrap_or_default(),
                }
            }),
        });
        state.threads.extend(threads);
        let page = pull.review_threads.page_info;
        if !page.has_next_page {
            break;
        }
        after = page.end_cursor;
    }
    result.ok_or_else(|| GitHubError::missing("the review threads"))
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlacedThreads {
    /// (side, line) to the threads shown on that diff line.
    pub by_line: BTreeMap<(Side, u32), Vec<ReviewThread>>,
    /// Outdated and file-level threads, listed above the file's diff.
    pub listed: Vec<ReviewThread>,
}

/// Splits one file's threads into those on a line of the current diff and the rest.
pub fn place_threads(threads: &[ReviewThread]) -> PlacedThreads {
    let mut placed = PlacedThreads::default();
    for thread in threads {
        match thread.line {
            Some(line) if !thread.file_level => placed
                .by_line
                .entry((thread.side, line))
                .or_default()
                .push(thread.clone()),
            _ => placed.listed.push(thread.clone()),
        }
    }
    placed
}

/// Reading order: by file (in the order given), listed threads first, then by line, old side
/// first. Threads on paths not given are dropped.
pub fn order_threads(threads: &[ReviewThread], paths: &[&str]) -> Vec<ReviewThread> {
    let rank: HashMap<&str, usize> = paths.iter().enumerate().map(|(i, p)| (*p, i)).collect();
    let position = |t: &ReviewThread| match t.line {
        Some(line) if !t.file_level => i64::from(line),
        _ => -1,
    };
    let mut ordered: Vec<ReviewThread> = threads
        .iter()
        .filter(|t| rank.contains_key(t.path.as_str()))
        .cloned()
        .collect();
    ordered.sort_by(|a, b| {
        rank[a.path.as_str()]
            .cmp(&rank[b.path.as_str()])
            .then(position(a).cmp(&position(b)))
            .then(a.side.cmp(&b.side))
    });
    ordered
}

pub fn reply_to_thread(client: &Client, thread_id: &str, body: &str) -> Result<ThreadComment> {
    #[derive(Deserialize)]
    struct Reply {
        comment: RawComment,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Data {
        add_pull_request_review_thread_reply: Option<Reply>,
    }
    let query = format!(
        "mutation Reply($thread: ID!, $body: String!) {{
  addPullRequestReviewThreadReply(input: {{ pullRequestReviewThreadId: $thread, body: $body }}) {{ comment {{ {COMMENT_FIELDS} }} }}
}}"
    );
    let data: Data = client.graphql(&query, json!({ "thread": thread_id, "body": body }))?;
    data.add_pull_request_review_thread_reply
        .map(|r| r.comment.into())
        .ok_or_else(|| GitHubError::missing("the reply"))
}

/// Resolves or unresolves; returns whether the thread is resolved now.
pub fn set_thread_resolved(client: &Client, thread_id: &str, resolved: bool) -> Result<bool> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Thread {
        is_resolved: bool,
    }
    #[derive(Deserialize)]
    struct Payload {
        thread: Thread,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Data {
        resolve_review_thread: Option<Payload>,
        unresolve_review_thread: Option<Payload>,
    }
    let mutation = if resolved {
        "mutation Resolve($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { id isResolved } } }"
    } else {
        "mutation Unresolve($thread: ID!) { unresolveReviewThread(input: { threadId: $thread }) { thread { id isResolved } } }"
    };
    let data: Data = client.graphql(mutation, json!({ "thread": thread_id }))?;
    let payload = data.resolve_review_thread.or(data.unresolve_review_thread);
    Ok(payload.map_or(resolved, |p| p.thread.is_resolved))
}

/// A thread for a pending review: one line, or a range from `start_line` to `line`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewThread<'a> {
    pub path: &'a str,
    pub line: u32,
    pub side: Side,
    pub start_line: Option<u32>,
    pub start_side: Option<Side>,
    pub body: &'a str,
}

/// Adds a thread to an existing pending review; returns the new comment's REST id.
pub fn add_thread_to_review(
    client: &Client,
    review_node_id: &str,
    thread: &NewThread,
) -> Result<Option<u64>> {
    #[derive(Deserialize)]
    struct Comment {
        #[serde(rename = "databaseId")]
        database_id: Option<u64>,
    }
    #[derive(Deserialize)]
    struct Thread {
        comments: Nodes<Comment>,
    }
    #[derive(Deserialize)]
    struct Payload {
        thread: Thread,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Data {
        add_pull_request_review_thread: Option<Payload>,
    }
    const ADD_THREAD: &str = "mutation AddThread($review: ID!, $path: String!, $line: Int!, $side: DiffSide!, $startLine: Int, $startSide: DiffSide, $body: String!) {
  addPullRequestReviewThread(input: { pullRequestReviewId: $review, path: $path, line: $line, side: $side, startLine: $startLine, startSide: $startSide, body: $body }) {
    thread { id comments(first: 1) { nodes { databaseId } } }
  }
}";
    let variables = json!({
        "review": review_node_id,
        "path": thread.path,
        "line": thread.line,
        "side": github_side(thread.side),
        "startLine": thread.start_line,
        "startSide": thread.start_line.map(|_| github_side(thread.start_side.unwrap_or(thread.side))),
        "body": thread.body,
    });
    let data: Data = client.graphql(ADD_THREAD, variables)?;
    Ok(data
        .add_pull_request_review_thread
        .and_then(|p| p.thread.comments.nodes.into_iter().flatten().next())
        .and_then(|c| c.database_id))
}
