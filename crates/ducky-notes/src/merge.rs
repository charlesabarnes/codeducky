use std::collections::HashMap;

use ducky_review::{Note, NoteId};

use crate::record::Record;

/// Three-way merge of a review's notes, per note by id.
///
/// `base` is what the caller last loaded, `ours` what it holds now, `theirs` what is on disk now
/// (an agent may have edited it). A note changed on both sides keeps the later `updated_at`; a
/// tie goes to the disk. A note deleted on one side stays deleted unless the other side edited
/// it after `base`. Notes new on either side are kept. Disk order is kept, ours appended.
pub fn merge_notes(base: &[Note], ours: &[Note], theirs: Vec<Record<Note>>) -> Vec<Record<Note>> {
    let by_id = |notes: &[Note]| -> HashMap<NoteId, Note> {
        notes
            .iter()
            .map(|note| (note.id.clone(), note.clone()))
            .collect()
    };
    let base = by_id(base);
    let mut ours_left = by_id(ours);
    let mut merged = Vec::with_capacity(theirs.len());

    for mut record in theirs {
        let id = record.value.id.clone();
        match ours_left.remove(&id) {
            Some(our) => {
                if our.updated_at > record.value.updated_at {
                    record.value = our;
                }
                merged.push(record);
            }
            None => {
                let deleted_by_us = base
                    .get(&id)
                    .is_some_and(|loaded| record.value.updated_at <= loaded.updated_at);
                if !deleted_by_us {
                    merged.push(record);
                }
            }
        }
    }
    for our in ours {
        let Some(our) = ours_left.remove(&our.id) else {
            continue;
        };
        let deleted_on_disk = base
            .get(&our.id)
            .is_some_and(|loaded| our.updated_at <= loaded.updated_at);
        if !deleted_on_disk {
            merged.push(Record::new(our));
        }
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;
    use ducky_review::{Anchor, NewNote, Side, Timestamp};
    use serde_json::{Map, Value};

    fn note(id: &str, body: &str, at: i64) -> Note {
        NewNote::new("a.ts", Anchor::at_line(Side::New, 1, None), body)
            .into_note(NoteId::from(id), Timestamp(at))
    }

    fn records(notes: &[Note]) -> Vec<Record<Note>> {
        notes.iter().cloned().map(Record::new).collect()
    }

    fn bodies(records: &[Record<Note>]) -> Vec<(&str, &str)> {
        records
            .iter()
            .map(|record| (record.value.id.as_str(), record.value.body.as_str()))
            .collect()
    }

    #[test]
    fn keeps_the_later_edit_of_each_note() {
        let base = [note("a", "a0", 1), note("b", "b0", 1)];
        let ours = [note("a", "a-ours", 5), note("b", "b-ours", 2)];
        let theirs = records(&[note("a", "a-disk", 3), note("b", "b-disk", 4)]);
        assert_eq!(
            bodies(&merge_notes(&base, &ours, theirs)),
            [("a", "a-ours"), ("b", "b-disk")]
        );
    }

    #[test]
    fn a_tie_goes_to_the_disk() {
        let base = [note("a", "a0", 1)];
        let merged = merge_notes(
            &base,
            &[note("a", "ours", 1)],
            records(&[note("a", "disk", 1)]),
        );
        assert_eq!(bodies(&merged), [("a", "disk")]);
    }

    #[test]
    fn keeps_notes_added_on_either_side() {
        let base = [note("a", "a", 1)];
        let ours = [note("a", "a", 1), note("mine", "m", 2)];
        let theirs = records(&[note("a", "a", 1), note("agent", "g", 3)]);
        assert_eq!(
            bodies(&merge_notes(&base, &ours, theirs)),
            [("a", "a"), ("agent", "g"), ("mine", "m")]
        );
    }

    #[test]
    fn deletes_stick_unless_the_other_side_edited_the_note_since() {
        let base = [
            note("a", "a", 1),
            note("b", "b", 1),
            note("c", "c", 1),
            note("d", "d", 1),
        ];
        let ours = [note("c", "c", 1), note("d", "d-edited", 2)];
        let theirs = records(&[note("a", "a", 1), note("b", "b-edited", 2)]);
        assert_eq!(
            bodies(&merge_notes(&base, &ours, theirs)),
            [("b", "b-edited"), ("d", "d-edited")]
        );
    }

    #[test]
    fn keeps_the_disk_copys_unknown_fields() {
        let mut extra = Map::new();
        extra.insert("agent_ref".into(), Value::from("task-7"));
        let theirs = vec![Record {
            value: note("a", "disk", 1),
            extra: extra.clone(),
        }];
        let merged = merge_notes(&[note("a", "a", 1)], &[note("a", "ours", 9)], theirs);
        assert_eq!(merged[0].value.body, "ours");
        assert_eq!(merged[0].extra, extra);
    }
}
