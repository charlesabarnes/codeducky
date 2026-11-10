use crate::ids::NoteId;
use crate::note::Note;
use crate::time::Timestamp;

/// Copies the open notes into another review (a branch's notes into its pull request review),
/// each with a fresh id from `next_id` and without its GitHub comment link.
pub fn carry_over_notes(
    previous: &[Note],
    now: Timestamp,
    mut next_id: impl FnMut() -> NoteId,
) -> Vec<Note> {
    previous
        .iter()
        .filter(|note| note.is_open() && !note.id.is_empty())
        .map(|note| Note {
            id: next_id(),
            carried_from: Some(note.id.clone()),
            updated_at: now,
            github: None,
            ..note.clone()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anchor::Anchor;
    use crate::note::{Author, GithubComment, NewNote, NoteStatus, Severity};
    use crate::side::Side;

    fn note(id: u32, status: NoteStatus) -> Note {
        let mut new = NewNote::new(
            "a",
            Anchor::at_line(Side::New, 1, None),
            format!("note {id}"),
        );
        new.severity = Severity::Nit;
        let mut note = new.into_note(NoteId::new(format!("n{id}")), Timestamp(5));
        note.status = status;
        note.github = Some(GithubComment {
            comment_id: Some(9),
            ..GithubComment::default()
        });
        note
    }

    #[test]
    fn copies_open_notes_without_ids_or_github_links() {
        let previous = [
            note(1, NoteStatus::Open),
            note(2, NoteStatus::Resolved),
            note(3, NoteStatus::Dismissed),
        ];
        let carried = carry_over_notes(&previous, Timestamp(100), || NoteId::from("fresh1"));
        assert_eq!(carried.len(), 1);
        let copy = &carried[0];
        assert_eq!(copy.id, NoteId::from("fresh1"));
        assert_eq!(copy.carried_from, Some(NoteId::from("n1")));
        assert_eq!(
            (copy.created_at, copy.updated_at),
            (Timestamp(5), Timestamp(100))
        );
        assert_eq!(copy.github, None);
        assert_eq!(copy.body, "note 1");
        assert_eq!(copy.author, Author::Human);
    }
}
