//! Notes to GitHub: into your pending review, or submitted as a review. Every note that went is
//! linked to its GitHub comment afterwards.

use ducky_github::review::{
    NoteLinks, PushPreview, PushResult, PushSelection, SubmitInput, SubmitResult, prepare_pr_push,
    push_pending_review, push_to_pending_review, submit_pr_review, unpushed_notes,
};
use ducky_github::threads::PendingReview;

use crate::error::{Result, SessionError};
use crate::review::Review;

/// Where each open note not yet on GitHub would land on the pull request's diff, and why the
/// others cannot be placed. `None` for a branch review.
pub fn push_preview(review: &Review) -> Option<PushPreview> {
    let pull = review.pull.as_ref()?;
    Some(prepare_pr_push(
        pull.pr(),
        &pull.snapshot.files,
        &unpushed_notes(&review.notes),
    ))
}

/// Adds the selected notes to your pending review, creating it when there is none. Nothing is
/// published: a pending review is only yours until you submit it.
pub fn push_notes(
    review: &Review,
    pending: Option<&PendingReview>,
    selection: &PushSelection,
) -> Result<PushResult> {
    let pull = review.pull.as_ref().ok_or(SessionError::NeedsCheckout)?;
    let result = match pending {
        Some(pending) => {
            push_to_pending_review(&pull.client, &pull.repo, pull.number(), pending, selection)?
        }
        None => push_pending_review(&pull.client, &pull.repo, pull.pr(), selection)?,
    };
    link(review, &result.links)?;
    Ok(result)
}

/// Submits your review (your pending one, if any, with `input`'s notes added to it); since
/// last look then starts from the head you submitted on.
pub fn submit_review(
    review: &Review,
    pending: Option<&PendingReview>,
    input: &SubmitInput,
) -> Result<SubmitResult> {
    let pull = review.pull.as_ref().ok_or(SessionError::NeedsCheckout)?;
    let result = submit_pr_review(
        &pull.client,
        &pull.repo,
        pull.number(),
        pull.head_sha(),
        pending,
        input,
    )?;
    link(review, &result.links)?;
    review.notes_service().mark_reviewed(&review.files)?;
    Ok(result)
}

fn link(review: &Review, links: &NoteLinks) -> Result<()> {
    let service = review.notes_service();
    for (id, comment) in links {
        service.link_github(id, comment.clone())?;
    }
    Ok(())
}
