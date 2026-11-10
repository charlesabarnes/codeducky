//! Review checklists: their model, and import/export as JSON or Markdown task lists.

mod format;
mod model;

pub use format::{
    ChecklistFormatError, checklists_to_json, checklists_to_markdown, parse_checklist_file,
    parse_checklist_json, parse_checklist_markdown,
};
pub use model::{
    Checklist, ChecklistDraft, ChecklistItem, ChecklistScope, ScopedChecklist,
    applicable_checklists,
};
