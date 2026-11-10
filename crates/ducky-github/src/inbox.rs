//! Pull requests waiting on you, yours, and ones you reviewed, in one GraphQL search request.

use std::collections::HashSet;

use ducky_review::Timestamp;
use serde::Deserialize;
use serde_json::json;

use crate::client::Client;
use crate::error::Result;

const PAGE: u32 = 50;
const REVIEWED_PAGE: u32 = 20;
pub const REVIEWED_DAYS: i64 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InboxSection {
    Requested,
    Mine,
    Reviewed,
}

impl InboxSection {
    pub const ALL: [Self; 3] = [Self::Requested, Self::Mine, Self::Reviewed];

    pub fn title(self) -> &'static str {
        match self {
            Self::Requested => "Review requested",
            Self::Mine => "Your open PRs",
            Self::Reviewed => "Recently reviewed by you",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CiRollup {
    Pass,
    Fail,
    Pending,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum InboxState {
    Open,
    Closed,
    Merged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxRow {
    pub owner: String,
    pub name: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub author: String,
    pub created_at: String,
    pub updated_at: String,
    pub draft: bool,
    pub state: InboxState,
    pub additions: u32,
    pub deletions: u32,
    pub changed_files: u32,
    pub ci: CiRollup,
    /// You have a review on it that is not submitted yet.
    pub pending_review: bool,
    /// Your latest submitted review, e.g. `APPROVED`.
    pub my_review: Option<String>,
    /// Requested from a team you are on rather than from you by name.
    pub via_team: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inbox {
    pub viewer: String,
    pub requested: Vec<InboxRow>,
    pub mine: Vec<InboxRow>,
    pub reviewed: Vec<InboxRow>,
    /// Total matches per section, which can exceed the rows fetched: requested, mine, reviewed.
    pub totals: [u32; 3],
    pub fetched_at: Timestamp,
}

impl Inbox {
    pub fn section(&self, section: InboxSection) -> &[InboxRow] {
        match section {
            InboxSection::Requested => &self.requested,
            InboxSection::Mine => &self.mine,
            InboxSection::Reviewed => &self.reviewed,
        }
    }

    pub fn total(&self, section: InboxSection) -> u32 {
        self.totals[section as usize]
    }
}

/// Why an inbox may come back empty: the token's reach, not an empty queue.
pub const TOKEN_SCOPE_HINT: &str = "Search only returns pull requests the token can read. A \
fine-grained token must have the organization as its resource owner (or \"All repositories\" for \
your own account) and include each repository, with Pull requests: read and write, Contents: \
read, and Commit statuses and Checks: read for CI. Organizations can block fine-grained tokens or \
require approval for them. A classic token needs the repo scope, and SSO authorization for orgs \
that use SAML.";

const FIELDS: &str = "
  ... on PullRequest {
    number title url isDraft state createdAt updatedAt additions deletions changedFiles
    author { login }
    repository { name owner { login } }
    viewerLatestReview { state }
    pending: reviews(states: PENDING, first: 1) { totalCount }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  }";

pub fn inbox_query() -> String {
    format!(
        "query Inbox($requested: String!, $direct: String!, $mine: String!, $reviewed: String!) {{
  viewer {{ login }}
  requested: search(query: $requested, type: ISSUE, first: {PAGE}) {{ issueCount nodes {{ {FIELDS} }} }}
  direct: search(query: $direct, type: ISSUE, first: {PAGE}) {{ nodes {{ ... on PullRequest {{ url }} }} }}
  mine: search(query: $mine, type: ISSUE, first: {PAGE}) {{ issueCount nodes {{ {FIELDS} }} }}
  reviewed: search(query: $reviewed, type: ISSUE, first: {REVIEWED_PAGE}) {{ issueCount nodes {{ {FIELDS} }} }}
}}"
    )
}

/// The searches behind each section. `review-requested:@me` covers your teams too;
/// `user-review-requested:@me` only you, which tells the two apart.
pub fn inbox_queries(now: Timestamp) -> serde_json::Value {
    let since = Timestamp::from_millis(now.millis() - REVIEWED_DAYS * 86_400_000).date();
    json!({
        "requested": "is:pr is:open archived:false review-requested:@me sort:updated-desc",
        "direct": "is:pr is:open archived:false user-review-requested:@me sort:updated-desc",
        "mine": "is:pr is:open archived:false author:@me sort:updated-desc",
        "reviewed": format!("is:pr archived:false reviewed-by:@me -author:@me updated:>={since} sort:updated-desc"),
    })
}

pub fn ci_rollup(state: Option<&str>) -> CiRollup {
    match state {
        Some("SUCCESS") => CiRollup::Pass,
        Some("FAILURE" | "ERROR") => CiRollup::Fail,
        Some("PENDING" | "EXPECTED") => CiRollup::Pending,
        _ => CiRollup::None,
    }
}

#[derive(Deserialize)]
struct Login {
    login: String,
}

#[derive(Deserialize)]
struct State {
    state: Option<String>,
}

#[derive(Deserialize)]
struct Count {
    #[serde(rename = "totalCount")]
    total_count: u32,
}

#[derive(Deserialize)]
struct RawRepository {
    name: String,
    owner: Login,
}

#[derive(Deserialize)]
struct RawCommitNode {
    commit: RawCommit,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCommit {
    status_check_rollup: Option<State>,
}

#[derive(Deserialize)]
struct RawCommits {
    nodes: Vec<Option<RawCommitNode>>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RawNode {
    number: Option<u64>,
    title: Option<String>,
    url: Option<String>,
    is_draft: bool,
    state: Option<InboxState>,
    created_at: Option<String>,
    updated_at: Option<String>,
    additions: u32,
    deletions: u32,
    changed_files: u32,
    author: Option<Login>,
    repository: Option<RawRepository>,
    viewer_latest_review: Option<State>,
    pending: Option<Count>,
    commits: Option<RawCommits>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSearch {
    issue_count: Option<u32>,
    nodes: Vec<Option<RawNode>>,
}

#[derive(Deserialize)]
struct RawUrl {
    url: Option<String>,
}

#[derive(Deserialize)]
struct RawDirect {
    nodes: Vec<Option<RawUrl>>,
}

#[derive(Deserialize)]
struct RawInbox {
    viewer: Login,
    requested: Option<RawSearch>,
    direct: Option<RawDirect>,
    mine: Option<RawSearch>,
    reviewed: Option<RawSearch>,
}

fn to_row(node: RawNode, direct: Option<&HashSet<String>>) -> Option<InboxRow> {
    // Hits that are not pull requests, or that the token cannot read, come back empty.
    let (url, number, repository) = (node.url?, node.number?, node.repository?);
    let rollup = node
        .commits
        .and_then(|c| c.nodes.into_iter().next().flatten())
        .and_then(|n| n.commit.status_check_rollup)
        .and_then(|s| s.state);
    Some(InboxRow {
        owner: repository.owner.login,
        name: repository.name,
        number,
        title: node.title.unwrap_or_default(),
        via_team: direct.is_some_and(|set| !set.contains(&url)),
        url,
        author: node.author.map_or_else(|| "ghost".into(), |a| a.login),
        created_at: node.created_at.unwrap_or_default(),
        updated_at: node.updated_at.unwrap_or_default(),
        draft: node.is_draft,
        state: node.state.unwrap_or(InboxState::Open),
        additions: node.additions,
        deletions: node.deletions,
        changed_files: node.changed_files,
        ci: ci_rollup(rollup.as_deref()),
        pending_review: node.pending.is_some_and(|p| p.total_count > 0),
        my_review: node.viewer_latest_review.and_then(|r| r.state),
    })
}

fn rows(search: Option<RawSearch>, direct: Option<&HashSet<String>>) -> (Vec<InboxRow>, u32) {
    let Some(search) = search else {
        return (Vec::new(), 0);
    };
    let rows: Vec<InboxRow> = search
        .nodes
        .into_iter()
        .flatten()
        .filter_map(|node| to_row(node, direct))
        .collect();
    let total = search.issue_count.unwrap_or(rows.len() as u32);
    (rows, total)
}

fn map_inbox(raw: RawInbox, fetched_at: Timestamp) -> Inbox {
    let direct: Option<HashSet<String>> = raw.direct.map(|d| {
        d.nodes
            .into_iter()
            .flatten()
            .filter_map(|n| n.url)
            .collect()
    });
    let (requested, requested_total) = rows(raw.requested, direct.as_ref());
    let (mine, mine_total) = rows(raw.mine, None);
    let (reviewed, reviewed_total) = rows(raw.reviewed, None);
    Inbox {
        viewer: raw.viewer.login,
        requested,
        mine,
        reviewed,
        totals: [requested_total, mine_total, reviewed_total],
        fetched_at,
    }
}

/// All three sections in one request. Repositories the token cannot read are left out.
pub fn fetch_inbox(client: &Client, now: Timestamp) -> Result<Inbox> {
    let raw: RawInbox = client.graphql_partial(&inbox_query(), inbox_queries(now))?;
    Ok(map_inbox(raw, now))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_check_rollups() {
        let states = [
            Some("SUCCESS"),
            Some("FAILURE"),
            Some("ERROR"),
            Some("PENDING"),
            Some("EXPECTED"),
            None,
        ];
        assert_eq!(
            states.map(ci_rollup),
            [
                CiRollup::Pass,
                CiRollup::Fail,
                CiRollup::Fail,
                CiRollup::Pending,
                CiRollup::Pending,
                CiRollup::None
            ]
        );
    }

    #[test]
    fn reviewed_section_looks_back_thirty_days() {
        let queries = inbox_queries(Timestamp::utc(2026, 10, 3, 12, 0));
        assert!(
            queries["reviewed"]
                .as_str()
                .unwrap()
                .contains("updated:>=2026-09-03")
        );
        assert!(
            queries["direct"]
                .as_str()
                .unwrap()
                .contains("user-review-requested:@me")
        );
    }
}
