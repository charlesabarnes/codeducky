//! Notes and review state as plain JSON files in `<git common dir>/codeducky/`, read and written
//! over a `Host`, so they follow the repository to whichever machine holds it and a coding agent
//! working there can read and resolve notes with ordinary file edits.
//!
//! ```text
//! codeducky/
//!   README.md                     how an agent lists, resolves and adds notes
//!   checklists.json               the repo's checklists
//!   branches/<branch>/notes.json  one review's notes
//!   branches/<branch>/state.json  its viewed files, last look and ticked checklist items
//!   pulls/<number>/...            the same for a pull request
//! ```
//!
//! Every change re-reads the file, applies itself to that fresh copy and writes the whole file
//! back, so edits an agent made meanwhile survive. A file that does not parse is reported and
//! never overwritten.

mod checklists_file;
mod document;
mod error;
mod ids;
mod layout;
mod merge;
mod notes_file;
mod record;
mod state_file;
mod store;

pub use document::VERSION;
pub use error::NotesError;
pub use layout::git_common_dir;
pub use merge::merge_notes;
pub use record::Record;
pub use store::{NotesRepo, ReviewNotes};
