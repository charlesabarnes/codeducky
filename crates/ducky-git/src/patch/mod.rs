//! Unified diffs as `git diff` prints them (with `a/` and `b/` prefixes), parsed into files,
//! hunks and numbered lines. Combined (merge) diffs are skipped.

mod parse;
mod quote;

pub use parse::{PatchError, parse_patch};

use crate::model::{ChangeStatus, FileKind, Mode};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDiff {
    /// `None` for an added file.
    pub old_path: Option<String>,
    /// `None` for a deleted file.
    pub new_path: Option<String>,
    pub status: ChangeStatus,
    pub old_mode: Option<Mode>,
    pub new_mode: Option<Mode>,
    pub similarity: Option<u8>,
    pub dissimilarity: Option<u8>,
    /// Abbreviated ids from the `index` line.
    pub old_oid: Option<String>,
    pub new_oid: Option<String>,
    /// `Binary files ... differ`: there are no hunks.
    pub binary: bool,
    pub hunks: Vec<Hunk>,
}

impl FileDiff {
    /// The path now; for a deletion, the path that was.
    pub fn path(&self) -> &str {
        self.new_path
            .as_deref()
            .or(self.old_path.as_deref())
            .unwrap_or_default()
    }

    pub fn kind(&self) -> FileKind {
        self.new_mode
            .or(self.old_mode)
            .map_or(FileKind::File, Mode::kind)
    }

    pub fn additions(&self) -> usize {
        self.lines_of(LineKind::Added)
    }

    pub fn deletions(&self) -> usize {
        self.lines_of(LineKind::Removed)
    }

    fn lines_of(&self, kind: LineKind) -> usize {
        self.hunks
            .iter()
            .flat_map(|h| &h.lines)
            .filter(|l| l.kind == kind)
            .count()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// The text after the second `@@` (often the enclosing function), trimmed.
    pub section: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LineKind {
    Context,
    Added,
    Removed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: LineKind,
    /// Without the leading marker or the newline; a CRLF line keeps its `\r`.
    pub text: String,
    /// 1-based; `None` on the side the line is not on.
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    /// `\ No newline at end of file` followed this line.
    pub no_newline: bool,
}
