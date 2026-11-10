use std::sync::Arc;

use ducky_git::{FileSide, Mode, Repo};
use ducky_review::diff::{
    DiffLine, LineEndingChange, LineKind, LineOptions, MoveInput, MovedRange, build_lines,
    detect_moved_blocks, line_ending_change,
};
use ducky_review::{ChangeStatus, NumberedLine, Side, number_lines};

use crate::changes::{ChangedFile, FileBadge};
use crate::error::Result;
use crate::sides::read_side;

/// Text sides past this are shown as too large to diff.
pub const MAX_TEXT_BYTES: usize = 2 << 20;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DiffOptions {
    pub ignore_whitespace: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffContent {
    Text(TextDiff),
    Binary {
        old_size: Option<u64>,
        new_size: Option<u64>,
    },
    TooLarge {
        old_size: Option<u64>,
        new_size: Option<u64>,
    },
    /// A nested repository: only its commit changed.
    Submodule {
        old: Option<String>,
        new: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextDiff {
    /// `None` when the file is absent on that side.
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    pub lines: Vec<DiffLine>,
    pub moved: Vec<MovedRange>,
    pub old_lines: Arc<[NumberedLine]>,
    pub new_lines: Arc<[NumberedLine]>,
}

/// Things worth saying above a file's diff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileNotice {
    Renamed {
        from: String,
        similarity: Option<u8>,
    },
    Copied {
        from: String,
        similarity: Option<u8>,
    },
    ModeChanged {
        old: Mode,
        new: Mode,
    },
    LineEndings(LineEndingChange),
    Untracked,
    /// Ignoring whitespace left nothing to show.
    WhitespaceOnly,
    /// Same content on both sides (a pure rename or mode change).
    NoContentChange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub content: DiffContent,
    pub notices: Vec<FileNotice>,
    pub options: DiffOptions,
}

impl FileDiff {
    pub fn text(&self) -> Option<&TextDiff> {
        match &self.content {
            DiffContent::Text(text) => Some(text),
            _ => None,
        }
    }

    /// The numbered lines of one side, for anchoring notes; `None` without text there.
    pub fn side_lines(&self, side: Side) -> Option<&[NumberedLine]> {
        let text = self.text()?;
        let present = match side {
            Side::Old => text.old_text.is_some(),
            Side::New => text.new_text.is_some(),
        };
        present.then(|| match side {
            Side::Old => &*text.old_lines,
            Side::New => &*text.new_lines,
        })
    }

    pub fn counts(&self) -> (u32, u32) {
        self.text().map_or((0, 0), |text| {
            text.lines
                .iter()
                .fold((0, 0), |(add, del), line| match line.kind {
                    LineKind::Add => (add + 1, del),
                    LineKind::Del => (add, del + 1),
                    LineKind::Context => (add, del),
                })
        })
    }
}

/// One file's diff: the base commit's copy against the working tree's.
pub fn load_file_diff(
    repo: &Repo,
    base: &str,
    file: &ChangedFile,
    options: DiffOptions,
) -> Result<FileDiff> {
    let mut notices = rename_notices(file);
    if file.git.untracked {
        notices.push(FileNotice::Untracked);
    }
    if let (Some(old), Some(new)) = (file.git.old_mode, file.git.new_mode)
        && old != new
        && old.kind() == new.kind()
    {
        notices.push(FileNotice::ModeChanged { old, new });
    }
    let content = if file.is_submodule() {
        DiffContent::Submodule {
            old: file.git.old_oid.clone(),
            new: file.git.new_oid.clone(),
        }
    } else {
        let old = match file.change.status {
            ChangeStatus::Added => None,
            _ => read_side(repo, base, file.base_path(), Side::Old)?,
        };
        let new = match file.change.status {
            ChangeStatus::Deleted => None,
            _ => read_side(repo, base, file.path(), Side::New)?,
        };
        text_content(file, old, new, options, &mut notices)
    };
    Ok(FileDiff {
        path: file.path().to_owned(),
        old_path: file.change.old_path.clone(),
        content,
        notices,
        options,
    })
}

fn rename_notices(file: &ChangedFile) -> Vec<FileNotice> {
    let from = file.git.old_path.clone();
    let similarity = file.git.similarity;
    match (file.badge(), from) {
        (FileBadge::Renamed, Some(from)) => vec![FileNotice::Renamed { from, similarity }],
        (FileBadge::Copied, Some(from)) => vec![FileNotice::Copied { from, similarity }],
        _ => Vec::new(),
    }
}

fn text_content(
    file: &ChangedFile,
    old: Option<FileSide>,
    new: Option<FileSide>,
    options: DiffOptions,
    notices: &mut Vec<FileNotice>,
) -> DiffContent {
    let size = |side: &Option<FileSide>| side.as_ref().map(FileSide::size);
    let (old_size, new_size) = (size(&old), size(&new));
    let is = |side: &Option<FileSide>, binary: bool| {
        matches!(
            (side, binary),
            (Some(FileSide::Binary { .. }), true) | (Some(FileSide::TooLarge { .. }), false)
        )
    };
    if file.git.is_binary() || is(&old, true) || is(&new, true) {
        return DiffContent::Binary { old_size, new_size };
    }
    if is(&old, false) || is(&new, false) {
        return DiffContent::TooLarge { old_size, new_size };
    }
    let text = |side: Option<FileSide>| match side {
        Some(FileSide::Text { text, .. }) => Some(text),
        _ => None,
    };
    let (old_text, new_text) = (text(old), text(new));
    let (old_str, new_str) = (
        old_text.as_deref().unwrap_or(""),
        new_text.as_deref().unwrap_or(""),
    );
    let lines = build_lines(
        old_str,
        new_str,
        LineOptions {
            ignore_whitespace: options.ignore_whitespace,
        },
    );
    if old_text.is_some()
        && new_text.is_some()
        && let Some(change) = line_ending_change(old_str, new_str)
    {
        notices.push(FileNotice::LineEndings(change));
    }
    let changed = lines.iter().any(|line| line.kind != LineKind::Context);
    if !changed && old_text.is_some() && new_text.is_some() {
        notices.push(if old_str == new_str {
            FileNotice::NoContentChange
        } else {
            FileNotice::WhitespaceOnly
        });
    }
    let moved = detect_moved_blocks(&[MoveInput {
        path: file.path(),
        lines: &lines,
    }])
    .remove(file.path())
    .unwrap_or_default();
    DiffContent::Text(TextDiff {
        old_lines: Arc::from(number_lines(old_str)),
        new_lines: Arc::from(number_lines(new_str)),
        old_text,
        new_text,
        lines,
        moved,
    })
}
