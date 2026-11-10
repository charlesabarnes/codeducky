//! What changed, per file. Paths are relative to the worktree's top folder; a path that is not
//! UTF-8 is decoded lossily.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    /// File to symlink, symlink to submodule, ...
    TypeChanged,
    /// A merge conflict that is not resolved yet.
    Unmerged,
}

/// A git file mode (`100644`, `100755`, `120000`, `160000`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Mode(pub u32);

impl Mode {
    pub const FILE: Mode = Mode(0o100644);
    pub const EXECUTABLE: Mode = Mode(0o100755);
    pub const SYMLINK: Mode = Mode(0o120000);
    pub const GITLINK: Mode = Mode(0o160000);

    pub fn parse(octal: &str) -> Option<Self> {
        u32::from_str_radix(octal, 8)
            .ok()
            .filter(|m| *m != 0)
            .map(Mode)
    }

    pub fn kind(self) -> FileKind {
        match self.0 & 0o170000 {
            0o120000 => FileKind::Symlink,
            0o160000 => FileKind::Submodule,
            _ => FileKind::File,
        }
    }

    pub fn is_executable(self) -> bool {
        self.kind() == FileKind::File && self.0 & 0o111 != 0
    }
}

impl std::fmt::Display for Mode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:06o}", self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FileKind {
    File,
    Symlink,
    /// Shown as its commit id only; its own changes are not looked into.
    Submodule,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineStats {
    Text { additions: u64, deletions: u64 },
    Binary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileChange {
    /// The path now; for a deletion, the path that was.
    pub path: String,
    /// The path before, for renames and copies.
    pub old_path: Option<String>,
    pub status: ChangeStatus,
    /// 0-100, for renames and copies.
    pub similarity: Option<u8>,
    pub old_mode: Option<Mode>,
    pub new_mode: Option<Mode>,
    pub old_oid: Option<String>,
    /// For the working tree, the id the content would get if added (`git hash-object`); `None`
    /// for deletions, and where it could not be computed (symlinks, nested repositories).
    pub new_oid: Option<String>,
    /// `None` when not computed (untracked files; fetch their patch for it).
    pub stats: Option<LineStats>,
    /// Not in the index: only in the working tree.
    pub untracked: bool,
}

impl FileChange {
    pub fn kind(&self) -> FileKind {
        self.new_mode
            .or(self.old_mode)
            .map_or(FileKind::File, Mode::kind)
    }

    pub fn is_binary(&self) -> bool {
        self.stats == Some(LineStats::Binary)
    }

    /// The paths this change touches: old then new for renames and copies.
    pub fn paths(&self) -> impl Iterator<Item = &str> {
        self.old_path
            .as_deref()
            .into_iter()
            .chain([self.path.as_str()])
    }

    pub fn mode_changed(&self) -> bool {
        matches!((self.old_mode, self.new_mode), (Some(a), Some(b)) if a != b)
    }
}
