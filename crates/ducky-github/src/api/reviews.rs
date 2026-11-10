use ducky_review::Side;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Value, json};
use ureq::http::Method;

use crate::client::Client;
use crate::error::Result;
use crate::remote::RepoRef;
use crate::url::repo_path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ReviewEvent {
    Approve,
    RequestChanges,
    Comment,
}

impl ReviewEvent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Approve => "APPROVE",
            Self::RequestChanges => "REQUEST_CHANGES",
            Self::Comment => "COMMENT",
        }
    }

    /// The review state GitHub records for it.
    pub fn submitted_state(self) -> &'static str {
        match self {
            Self::Approve => "APPROVED",
            Self::RequestChanges => "CHANGES_REQUESTED",
            Self::Comment => "COMMENTED",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Approve => "Approve",
            Self::RequestChanges => "Request changes",
            Self::Comment => "Comment",
        }
    }
}

/// GitHub's name for a diff side: LEFT is the base (`old`), RIGHT the change (`new`).
pub fn github_side(side: Side) -> &'static str {
    match side {
        Side::Old => "LEFT",
        Side::New => "RIGHT",
    }
}

pub(crate) fn side_from_github(side: &str) -> Side {
    if side == "LEFT" { Side::Old } else { Side::New }
}

fn serialize_side<S: Serializer>(side: &Side, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(github_side(*side))
}

fn serialize_start_side<S: Serializer>(
    side: &Option<Side>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match side {
        Some(side) => serialize_side(side, serializer),
        None => serializer.serialize_none(),
    }
}

/// One inline comment of a review; a multi-line comment runs from `start_line` to `line`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReviewCommentInput {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_start_side"
    )]
    pub start_side: Option<Side>,
    pub line: u32,
    #[serde(serialize_with = "serialize_side")]
    pub side: Side,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewInput {
    pub commit_id: String,
    pub body: String,
    pub comments: Vec<ReviewCommentInput>,
    /// Submits the review in the same call; without it the review stays pending.
    pub event: Option<ReviewEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Review {
    pub id: u64,
    pub state: String,
    pub html_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewComment {
    pub id: u64,
    pub path: String,
    pub line: Option<u32>,
    pub side: Option<Side>,
    pub body: String,
}

#[derive(Deserialize)]
struct RawReviewComment {
    id: u64,
    path: String,
    line: Option<u32>,
    side: Option<String>,
    body: String,
}

impl Client {
    /// Creates a review: submitted in the same call with an `event`, PENDING without one.
    pub fn create_review(
        &self,
        repo: &RepoRef,
        number: u64,
        input: &ReviewInput,
    ) -> Result<Review> {
        let mut body = json!({
            "commit_id": input.commit_id,
            "body": input.body,
            "comments": input.comments,
        });
        if let (Some(event), Value::Object(map)) = (input.event, &mut body) {
            map.insert("event".into(), event.as_str().into());
        }
        self.send_json(
            Method::POST,
            &format!("{}/pulls/{number}/reviews", repo_path(repo)),
            &body,
        )
    }

    pub fn submit_review(
        &self,
        repo: &RepoRef,
        number: u64,
        review_id: u64,
        event: ReviewEvent,
        body: &str,
    ) -> Result<Review> {
        self.send_json(
            Method::POST,
            &format!(
                "{}/pulls/{number}/reviews/{review_id}/events",
                repo_path(repo)
            ),
            &json!({ "event": event.as_str(), "body": body }),
        )
    }

    pub fn update_review_body(
        &self,
        repo: &RepoRef,
        number: u64,
        review_id: u64,
        body: &str,
    ) -> Result<()> {
        self.send_json::<Value>(
            Method::PUT,
            &format!("{}/pulls/{number}/reviews/{review_id}", repo_path(repo)),
            &json!({ "body": body }),
        )
        .map(drop)
    }

    pub fn review_comments(
        &self,
        repo: &RepoRef,
        number: u64,
        review_id: u64,
    ) -> Result<Vec<ReviewComment>> {
        let path = format!(
            "{}/pulls/{number}/reviews/{review_id}/comments",
            repo_path(repo)
        );
        self.paginate(&path, &[], |page: Vec<RawReviewComment>| {
            page.into_iter()
                .map(|c| ReviewComment {
                    id: c.id,
                    path: c.path,
                    line: c.line,
                    side: c.side.as_deref().map(side_from_github),
                    body: c.body,
                })
                .collect()
        })
    }
}
