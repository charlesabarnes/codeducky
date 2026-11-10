use ducky_review::{Note, ReviewTarget};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::document::{Document, VERSION, take};
use crate::error::NotesError;
use crate::ids::assign_missing_ids;
use crate::record::Record;

pub const NOTES_ABOUT: &str = "Code Ducky review notes. How to list, resolve and add notes: README.md in the codeducky folder above.";

/// `notes.json`: one review's notes.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NotesDocument {
    about: &'static str,
    pub version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<ReviewTarget>,
    pub notes: Vec<Record<Note>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl NotesDocument {
    pub fn new(target: ReviewTarget) -> Self {
        Self {
            about: NOTES_ABOUT,
            version: VERSION,
            target: Some(target),
            notes: Vec::new(),
            extra: Map::new(),
        }
    }

    pub fn notes(&self) -> Vec<Note> {
        self.notes
            .iter()
            .map(|record| record.value.clone())
            .collect()
    }

    pub fn find_mut(&mut self, id: &ducky_review::NoteId) -> Option<&mut Note> {
        self.notes
            .iter_mut()
            .map(|record| &mut record.value)
            .find(|note| note.id == *id)
    }
}

fn parse_note(value: Value, index: usize, path: &str) -> Result<Record<Note>, NotesError> {
    let id = value.get("id").and_then(Value::as_str).map(str::to_owned);
    serde_json::from_value(value).map_err(|error| {
        let which = id.map_or_else(
            || format!("note {}", index + 1),
            |id| format!("note {} (id {id})", index + 1),
        );
        NotesError::malformed(path, format!("{which}: {error}"))
    })
}

impl Document for NotesDocument {
    fn parse(mut root: Map<String, Value>, path: &str) -> Result<Self, NotesError> {
        root.remove("about");
        root.remove("version");
        let target = take::<Option<ReviewTarget>>(&mut root, "target", path)?;
        let notes = match root.remove("notes") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(notes)) => notes,
            Some(_) => return Err(NotesError::malformed(path, "`notes` should be a list")),
        };
        let mut notes = notes
            .into_iter()
            .enumerate()
            .map(|(index, value)| parse_note(value, index, path))
            .collect::<Result<Vec<_>, _>>()?;
        assign_missing_ids(&mut notes);
        Ok(Self {
            about: NOTES_ABOUT,
            version: VERSION,
            target,
            notes,
            extra: root,
        })
    }
}
