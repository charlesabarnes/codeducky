//! Sending notes to GitHub: as a pending review, into your existing pending review, or as a
//! submitted review. Nothing here stores anything: results carry the note-to-comment links for
//! the caller to save on the notes.

use std::collections::HashMap;

use ducky_review::summary::compare_notes;
use ducky_review::{GithubComment, Note, NoteId, Severity};

use crate::api::files::PullFile;
use crate::api::pulls::PullRequest;
use crate::api::reviews::{Review, ReviewEvent, ReviewInput};
use crate::client::Client;
use crate::error::{ErrorKind, GitHubError, Result};
use crate::placement::{
    PlacedNote, Placement, comment_ids_by_note, pending_review_input, place_notes, review_body,
};
use crate::remote::RepoRef;
use crate::threads::{NewThread, PendingReview, add_thread_to_review};

/// Notes that can be sent: open ones.
pub fn pushable_notes(notes: &[Note]) -> Vec<Note> {
    notes.iter().filter(|n| n.is_open()).cloned().collect()
}

/// Open notes not already in a review on GitHub.
pub fn unpushed_notes(notes: &[Note]) -> Vec<Note> {
    notes
        .iter()
        .filter(|n| n.is_open() && n.github.as_ref().is_none_or(|g| g.review_id.is_none()))
        .cloned()
        .collect()
}

fn first_line(note: &Note) -> String {
    let text = note
        .body
        .split('\n')
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .trim();
    if text.chars().count() > 100 {
        format!("{}…", text.chars().take(99).collect::<String>())
    } else {
        text.to_owned()
    }
}

/// The default review body: what the open notes add up to, worst first.
pub fn review_summary(notes: &[Note]) -> String {
    let mut open: Vec<&Note> = notes.iter().filter(|n| n.is_open()).collect();
    if open.is_empty() {
        return String::new();
    }
    let counts: Vec<String> = Severity::ALL
        .iter()
        .rev()
        .filter_map(|severity| {
            let count = open.iter().filter(|n| n.severity == *severity).count();
            (count > 0).then(|| format!("{count} {}", severity.as_str()))
        })
        .collect();
    open.sort_by(|a, b| {
        a.severity
            .rank()
            .cmp(&b.severity.rank())
            .then_with(|| compare_notes(a, b))
    });
    let plural = if open.len() == 1 { "" } else { "s" };
    let mut lines = vec![
        format!("{} note{plural}: {}.", open.len(), counts.join(", ")),
        String::new(),
    ];
    lines.extend(open.iter().map(|n| {
        format!(
            "- **{}** `{}:{}` {}",
            n.severity.as_str(),
            n.path,
            n.anchor.line_span(),
            first_line(n)
        )
    }));
    lines.join("\n")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushPreview {
    pub pr: PullRequest,
    pub placement: Placement,
    /// The commit the notes were made on locally; differs from `pr.head_sha` when unpushed.
    pub local_head: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushLookup {
    NoPullRequest,
    Ready(Box<PushPreview>),
}

/// For a branch review: finds the branch's open PR and places the open notes on its diff.
pub fn prepare_push(
    client: &Client,
    repo: &RepoRef,
    branch: &str,
    local_head: &str,
    notes: &[Note],
    renames: &HashMap<String, String>,
) -> Result<PushLookup> {
    let Some(pr) = client.open_pull_for_branch(repo, branch, None)? else {
        return Ok(PushLookup::NoPullRequest);
    };
    let files = client.pull_files(repo, pr.number)?;
    Ok(PushLookup::Ready(Box::new(PushPreview {
        placement: place_notes(&pushable_notes(notes), &files, renames),
        local_head: local_head.to_owned(),
        pr,
    })))
}

/// For a PR review: the session diff is the PR diff, so no lookup is needed.
pub fn prepare_pr_push(pr: &PullRequest, files: &[PullFile], notes: &[Note]) -> PushPreview {
    PushPreview {
        pr: pr.clone(),
        placement: place_notes(&pushable_notes(notes), files, &HashMap::new()),
        local_head: pr.head_sha.clone(),
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PushSelection {
    pub placed: Vec<PlacedNote>,
    pub body_notes: Vec<Note>,
}

impl From<Placement> for PushSelection {
    fn from(placement: Placement) -> Self {
        Self {
            placed: placement.placed,
            body_notes: placement.unplaced.into_iter().map(|u| u.note).collect(),
        }
    }
}

/// What to record on each note that went to GitHub.
pub type NoteLinks = Vec<(NoteId, GithubComment)>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushResult {
    pub review: Review,
    /// How many notes were paired with their GitHub comment.
    pub linked: usize,
    pub links: NoteLinks,
}

fn links<'a>(
    notes: impl IntoIterator<Item = &'a Note>,
    review_id: u64,
    comment_ids: &HashMap<NoteId, u64>,
) -> NoteLinks {
    notes
        .into_iter()
        .map(|note| {
            let link = GithubComment {
                review_id: Some(review_id),
                comment_id: comment_ids.get(&note.id).copied(),
            };
            (note.id.clone(), link)
        })
        .collect()
}

fn selection_notes(selection: &PushSelection) -> impl Iterator<Item = &Note> {
    selection
        .placed
        .iter()
        .map(|p| &p.note)
        .chain(&selection.body_notes)
}

/// Creates a PENDING review (no event): nothing is published until it is submitted.
pub fn push_pending_review(
    client: &Client,
    repo: &RepoRef,
    pr: &PullRequest,
    selection: &PushSelection,
) -> Result<PushResult> {
    let input = pending_review_input(&pr.head_sha, &selection.placed, &selection.body_notes);
    let review = client.create_review(repo, pr.number, &input)?;
    // The comments were created; failing to read their ids back only loses the pairing.
    let comment_ids = if selection.placed.is_empty() {
        HashMap::new()
    } else {
        client
            .review_comments(repo, pr.number, review.id)
            .map(|comments| comment_ids_by_note(&selection.placed, &comments))
            .unwrap_or_default()
    };
    Ok(PushResult {
        linked: comment_ids.len(),
        links: links(selection_notes(selection), review.id, &comment_ids),
        review,
    })
}

fn pending_id(pending: &PendingReview) -> Result<u64> {
    pending.database_id.ok_or_else(|| {
        GitHubError::new(
            ErrorKind::Invalid,
            0,
            "GitHub did not report the id of your pending review.",
        )
    })
}

fn add_threads(
    client: &Client,
    pending: &PendingReview,
    placed: &[PlacedNote],
) -> Result<HashMap<NoteId, u64>> {
    let mut ids = HashMap::new();
    for PlacedNote { note, comment, .. } in placed {
        let thread = NewThread {
            path: &comment.path,
            line: comment.line,
            side: comment.side,
            start_line: comment.start_line,
            start_side: comment.start_side,
            body: &comment.body,
        };
        if let Some(id) = add_thread_to_review(client, &pending.id, &thread)? {
            ids.insert(note.id.clone(), id);
        }
    }
    Ok(ids)
}

/// Adds notes to your existing pending review: placed notes as threads, the rest appended to
/// its body.
pub fn push_to_pending_review(
    client: &Client,
    repo: &RepoRef,
    number: u64,
    pending: &PendingReview,
    selection: &PushSelection,
) -> Result<PushResult> {
    let review_id = pending_id(pending)?;
    let comment_ids = add_threads(client, pending, &selection.placed)?;
    if !selection.body_notes.is_empty() {
        let extra = review_body(&selection.body_notes);
        let existing = pending.body.trim();
        let body = if existing.is_empty() {
            extra
        } else {
            format!("{existing}\n\n{extra}")
        };
        client.update_review_body(repo, number, review_id, &body)?;
    }
    Ok(PushResult {
        review: Review {
            id: review_id,
            state: "PENDING".into(),
            html_url: pending.url.clone(),
        },
        linked: comment_ids.len(),
        links: links(selection_notes(selection), review_id, &comment_ids),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmitInput {
    pub event: ReviewEvent,
    pub body: String,
    /// Unpushed notes to include: placed ones as inline comments, the rest in the body.
    pub placement: Option<Placement>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmitResult {
    pub review: Review,
    /// APPROVED, CHANGES_REQUESTED or COMMENTED.
    pub state: &'static str,
    pub comments: usize,
    pub links: NoteLinks,
}

/// The body as submitted: yours, plus notes that do not map onto the diff.
pub fn submit_body(input: &SubmitInput) -> String {
    let unplaced: Vec<Note> = input
        .placement
        .iter()
        .flat_map(|p| p.unplaced.iter().map(|u| u.note.clone()))
        .collect();
    [input.body.trim().to_owned(), review_body(&unplaced)]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// GitHub refuses a review with no body and no comments unless it approves.
pub fn needs_body(input: &SubmitInput, pending_comments: usize) -> bool {
    let comments = input.placement.as_ref().map_or(0, |p| p.placed.len()) + pending_comments;
    input.event != ReviewEvent::Approve && comments == 0 && submit_body(input).is_empty()
}

/// Submits your review: with a pending review, unpushed notes are added to it and it is
/// submitted; without one, a review is created and submitted in one call.
pub fn submit_pr_review(
    client: &Client,
    repo: &RepoRef,
    number: u64,
    head_sha: &str,
    pending: Option<&PendingReview>,
    input: &SubmitInput,
) -> Result<SubmitResult> {
    let empty = Placement::default();
    let placement = input.placement.as_ref().unwrap_or(&empty);
    let body = submit_body(input);
    let (review, comment_ids) = match pending {
        Some(pending) => {
            let review_id = pending_id(pending)?;
            let ids = add_threads(client, pending, &placement.placed)?;
            (
                client.submit_review(repo, number, review_id, input.event, &body)?,
                ids,
            )
        }
        None => {
            let review_input = ReviewInput {
                commit_id: head_sha.to_owned(),
                body,
                comments: placement.placed.iter().map(|p| p.comment.clone()).collect(),
                event: Some(input.event),
            };
            (
                client.create_review(repo, number, &review_input)?,
                HashMap::new(),
            )
        }
    };
    let included = placement
        .placed
        .iter()
        .map(|p| &p.note)
        .chain(placement.unplaced.iter().map(|u| &u.note));
    Ok(SubmitResult {
        links: links(included, review.id, &comment_ids),
        state: input.event.submitted_state(),
        comments: placement.placed.len(),
        review,
    })
}

/// A plainer message for the errors pushing commonly hits.
pub fn push_error_hint(error: &GitHubError) -> Option<&'static str> {
    (error.is(ErrorKind::Invalid) && error.message.to_lowercase().contains("pending review")).then_some(
        "You already have a pending review on this pull request. Submit or delete it on GitHub, then push again.",
    )
}
