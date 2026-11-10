//! What the review UI talks to: connecting to herdr-core (or falling back to this machine),
//! opening a review of a branch, loading one file's diff, and keeping its notes anchored.
//!
//! Everything blocks; call it from a background executor. Values handed back are plain data,
//! `Clone + Send`, so a UI can hold them while the next load runs.

pub mod agents;
mod browse;
mod changes;
mod checklists;
mod connection;
mod editor;
mod error;
mod file_diff;
pub mod github;
pub mod machines;
mod note_changes;
mod notes;
pub mod pull;
mod review;
mod sides;
mod since;
mod tree;
mod view;

pub use browse::{Folder, Listing, list_folders, resolve_home};
pub use changes::{ChangedFile, FileBadge, order};
pub use checklists::{
    ChecklistProgress, ChecklistStore, Checklists, ExportFormat, export_checklists,
};
pub use connection::{Connection, ConnectionState, CoreTarget};
pub use editor::{
    EditBuffer, Fingerprint, MAX_EDIT_BYTES, NotEditable, SaveOutcome, editable, open_for_edit,
    save_edit,
};
pub use error::{Result, SessionError};
pub use file_diff::{DiffContent, DiffOptions, FileDiff, FileNotice, MAX_TEXT_BYTES, TextDiff};
pub use note_changes::changed_notes;
pub use notes::{NoteDraft, NotesService};
pub use review::{Review, ReviewRequest, detached_target};
pub use sides::SideSource;
pub use since::{HeadMoved, SinceLook};
pub use tree::{TreeEntry, TreeRow, build_tree, matches_filter};
pub use view::{CommitScope, ReviewMode, ReviewView, ViewEntry};
