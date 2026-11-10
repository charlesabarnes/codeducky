use ducky_review::{ReviewState, ReviewTarget};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::document::{Document, VERSION, take};
use crate::error::NotesError;
use crate::record::Record;

pub const STATE_ABOUT: &str =
    "Code Ducky review state: viewed files, last look, ticked checklist items. Written by the app.";

/// `state.json`: everything about one review except its notes.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StateDocument {
    about: &'static str,
    pub version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<ReviewTarget>,
    #[serde(flatten)]
    pub state: Record<ReviewState>,
}

impl StateDocument {
    pub fn new(target: ReviewTarget) -> Self {
        Self {
            about: STATE_ABOUT,
            version: VERSION,
            target: Some(target),
            state: Record::new(ReviewState::default()),
        }
    }
}

impl Document for StateDocument {
    fn parse(mut root: Map<String, Value>, path: &str) -> Result<Self, NotesError> {
        root.remove("about");
        root.remove("version");
        let target = take::<Option<ReviewTarget>>(&mut root, "target", path)?;
        let state = serde_json::from_value(Value::Object(root))
            .map_err(|error| NotesError::malformed(path, error))?;
        Ok(Self {
            about: STATE_ABOUT,
            version: VERSION,
            target,
            state,
        })
    }
}
