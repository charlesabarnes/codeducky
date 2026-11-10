//! What the review UI talks to: connecting to herdr-core (or falling back to this machine),
//! opening a review of a branch, loading one file's diff, and keeping its notes anchored.
//!
//! Everything blocks; call it from a background executor. Values handed back are plain data,
//! `Clone + Send`, so a UI can hold them while the next load runs.

mod changes;
mod connection;
mod error;
mod file_diff;
mod notes;
mod review;
mod sides;
mod tree;

pub use changes::{ChangedFile, FileBadge, order};
pub use connection::{Connection, ConnectionState};
pub use error::{Result, SessionError};
pub use file_diff::{
    DiffContent, DiffOptions, FileDiff, FileNotice, MAX_TEXT_BYTES, TextDiff, load_file_diff,
};
pub use notes::{NoteDraft, NotesService};
pub use review::{Review, ReviewRequest, detached_target};
pub use tree::{TreeEntry, TreeRow, build_tree, matches_filter};
