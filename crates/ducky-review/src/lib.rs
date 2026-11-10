//! Review domain logic: notes, anchors, review state, checklists and display diffs. No IO.
//!
//! Inputs are this crate's own small types (`FileChange`, `NumberedLine`, `DiffLine`,
//! `BranchCommit`); the git and GitHub layers map their models onto them.

pub mod anchor;
pub mod carry_over;
pub mod change;
pub mod checklist;
pub mod commit_range;
pub mod diff;
pub mod ids;
pub mod last_look;
pub mod lines;
pub mod matching;
pub mod note;
pub mod order;
pub mod patch;
pub mod reanchor;
pub mod report;
pub mod side;
pub mod state;
pub mod summary;
pub mod target;
pub mod time;
pub mod view_notes;
pub mod viewed;

pub use anchor::{Anchor, AnchorError, create_anchor};
pub use change::{BranchCommit, ChangeStatus, FileChange, FileStats};
pub use ids::{ChecklistId, ChecklistItemId, NoteId, Oid};
pub use lines::{NumberedLine, number_lines};
pub use note::{Author, GithubComment, NewNote, Note, NoteEdit, NoteStatus, Resolution, Severity};
pub use reanchor::{NoteUpdate, reanchor, reanchor_notes};
pub use side::Side;
pub use state::ReviewState;
pub use target::ReviewTarget;
pub use time::Timestamp;
