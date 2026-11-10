//! Which notes changed between two reads of the notes file: new ones, and ones whose status,
//! text or resolution moved (an agent resolving or adding notes).

use std::collections::HashSet;

use ducky_review::{Note, NoteId};

pub fn changed_notes(before: &[Note], after: &[Note]) -> HashSet<NoteId> {
    after
        .iter()
        .filter(|note| {
            before
                .iter()
                .find(|old| old.id == note.id)
                .is_none_or(|old| {
                    old.status != note.status
                        || old.body != note.body
                        || old.resolution != note.resolution
                        || old.updated_at != note.updated_at
                })
        })
        .map(|note| note.id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use ducky_review::{Anchor, Author, NewNote, Side, Timestamp};

    use super::*;

    fn note(id: &str) -> Note {
        NewNote::new("a.rs", Anchor::at_line(Side::New, 1, None), "body").into_note(
            NoteId::new(id),
            "2026-11-10T10:00:00Z".parse::<Timestamp>().unwrap(),
        )
    }

    #[test]
    fn new_and_resolved_notes_count_as_changed() {
        let before = vec![note("a"), note("b")];
        let mut after = before.clone();
        after[1].resolve(
            Author::Human,
            None,
            "2026-11-10T11:00:00Z".parse::<Timestamp>().unwrap(),
        );
        after.push(note("c"));
        let changed = changed_notes(&before, &after);
        assert_eq!(changed.len(), 2);
        assert!(changed.contains(&NoteId::new("b")));
        assert!(changed.contains(&NoteId::new("c")));
        assert!(changed_notes(&after, &after).is_empty());
    }
}
