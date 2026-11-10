use ducky_review::{NoteId, Timestamp, carry_over::carry_over_notes};

use crate::error::Result;
use crate::review::Review;

/// Copies the branch review's open notes into its pull request's review, once: notes already
/// carried over (by `carried_from`) are skipped. Returns how many were added.
pub fn carry_branch_notes(branch: &Review, pull: &Review) -> Result<usize> {
    let carried: Vec<&NoteId> = pull
        .notes
        .iter()
        .filter_map(|n| n.carried_from.as_ref())
        .collect();
    let fresh: Vec<_> = branch
        .notes
        .iter()
        .filter(|n| !carried.contains(&&n.id))
        .cloned()
        .collect();
    let notes = carry_over_notes(&fresh, Timestamp::now(), || NoteId::new(""));
    if notes.is_empty() {
        return Ok(0);
    }
    Ok(pull.notes_service().insert(notes)?.len())
}
