use ducky_review::checklist::Checklist;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::document::{Document, VERSION};
use crate::error::NotesError;
use crate::record::Record;

pub const CHECKLISTS_ABOUT: &str = "Code Ducky checklists for this repository. Written by the app.";

/// `checklists.json`: the repo's own checklists. Global ones live in the app's preferences.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChecklistsDocument {
    about: &'static str,
    pub version: u64,
    pub checklists: Vec<Record<Checklist>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for ChecklistsDocument {
    fn default() -> Self {
        Self {
            about: CHECKLISTS_ABOUT,
            version: VERSION,
            checklists: Vec::new(),
            extra: Map::new(),
        }
    }
}

impl Document for ChecklistsDocument {
    fn parse(mut root: Map<String, Value>, path: &str) -> Result<Self, NotesError> {
        root.remove("about");
        root.remove("version");
        let checklists = match root.remove("checklists") {
            None | Some(Value::Null) => Vec::new(),
            Some(value) => serde_json::from_value(value)
                .map_err(|error| NotesError::malformed(path, format!("`checklists`: {error}")))?,
        };
        Ok(Self {
            checklists,
            extra: root,
            ..Self::default()
        })
    }
}
