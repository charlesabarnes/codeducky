use std::hash::{DefaultHasher, Hash, Hasher};

use ducky_git::{FileKind, FileSide, Repo};

use crate::error::Result;
use crate::view::ViewEntry;

/// Past this a file is opened in the diff only: the editor is for edits, not for logs.
pub const MAX_EDIT_BYTES: usize = 1 << 20;

const BOM: &str = "\u{feff}";

/// Size and content hash of the bytes on disk when the editor read them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fingerprint {
    pub size: usize,
    pub hash: u64,
}

impl Fingerprint {
    pub fn of(bytes: &[u8]) -> Self {
        let mut hasher = DefaultHasher::new();
        bytes.hash(&mut hasher);
        Self {
            size: bytes.len(),
            hash: hasher.finish(),
        }
    }
}

/// A working-tree file as the editor shows it: LF line breaks and no BOM; both come back on save.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditBuffer {
    pub path: String,
    pub text: String,
    pub crlf: bool,
    pub bom: bool,
    pub on_disk: Fingerprint,
}

impl EditBuffer {
    fn from_bytes(path: &str, bytes: &[u8]) -> Option<Self> {
        let text = std::str::from_utf8(bytes).ok()?;
        let (bom, text) = match text.strip_prefix(BOM) {
            Some(rest) => (true, rest),
            None => (false, text),
        };
        let breaks = text.matches('\n').count();
        let crlf = breaks > 0 && text.matches("\r\n").count() == breaks;
        Some(Self {
            path: path.to_owned(),
            text: if crlf {
                text.replace("\r\n", "\n")
            } else {
                text.to_owned()
            },
            crlf,
            bom,
            on_disk: Fingerprint::of(bytes),
        })
    }

    /// The bytes to write for `text` as edited.
    pub fn encode(&self, text: &str) -> Vec<u8> {
        let body = if self.crlf {
            text.replace("\r\n", "\n").replace('\n', "\r\n")
        } else {
            text.to_owned()
        };
        let prefix = if self.bom { BOM } else { "" };
        format!("{prefix}{body}").into_bytes()
    }
}

/// Why a file cannot be edited from here.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NotEditable {
    #[error("this view shows the file as of a commit; edit it from All changes (g a)")]
    Historical,
    #[error("this file was deleted on the branch")]
    Deleted,
    #[error("this file is not in the working tree")]
    Missing,
    #[error("binary files cannot be edited here")]
    Binary,
    #[error("this file is too large to edit here ({0} bytes; the limit is 1 MiB)")]
    TooLarge(u64),
    #[error("submodules and symlinks are not edited here")]
    NotAFile,
    #[error("this file is not UTF-8 text")]
    NotText,
    #[error("this pull request is read from GitHub: open it from a checkout at its head to edit")]
    NoCheckout,
}

/// Whether the entry's new side is a working-tree file the editor can take, before reading it.
pub fn editable(entry: &ViewEntry) -> std::result::Result<(), NotEditable> {
    if !entry.shows_worktree {
        let from_github = matches!(entry.new, crate::SideSource::Blob(_))
            && !matches!(
                entry.note_view,
                ducky_review::view_notes::NoteView::Commit { .. }
            );
        return Err(if from_github {
            NotEditable::NoCheckout
        } else if entry.file.change.status == ducky_review::ChangeStatus::Deleted {
            NotEditable::Deleted
        } else {
            NotEditable::Historical
        });
    }
    if entry.file.git.kind() != FileKind::File {
        return Err(NotEditable::NotAFile);
    }
    if entry.file.git.is_binary() {
        return Err(NotEditable::Binary);
    }
    Ok(())
}

/// Reads the working-tree file for the editor.
pub fn open_for_edit(
    repo: &Repo,
    entry: &ViewEntry,
) -> Result<std::result::Result<EditBuffer, NotEditable>> {
    if let Err(reason) = editable(entry) {
        return Ok(Err(reason));
    }
    let path = entry.file.path();
    let Some(bytes) = repo.read_worktree(path)? else {
        return Ok(Err(NotEditable::Missing));
    };
    if bytes.len() > MAX_EDIT_BYTES {
        return Ok(Err(NotEditable::TooLarge(bytes.len() as u64)));
    }
    if matches!(
        FileSide::from_bytes(&bytes, MAX_EDIT_BYTES),
        FileSide::Binary { .. }
    ) {
        return Ok(Err(NotEditable::Binary));
    }
    Ok(EditBuffer::from_bytes(path, &bytes).ok_or(NotEditable::NotText))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveOutcome {
    /// Written; the buffer now matches the disk.
    Saved(EditBuffer),
    /// The file changed (or went) since the editor read it; nothing was written.
    Conflict { deleted: bool },
}

/// Writes `text` unless the file changed on disk since `buffer` was read; `force` writes anyway.
/// The check and the write are two calls, so an edit landing between them can still be lost.
pub fn save_edit(repo: &Repo, buffer: &EditBuffer, text: &str, force: bool) -> Result<SaveOutcome> {
    if !force {
        match repo.read_worktree(&buffer.path)? {
            None => return Ok(SaveOutcome::Conflict { deleted: true }),
            Some(bytes) if Fingerprint::of(&bytes) != buffer.on_disk => {
                return Ok(SaveOutcome::Conflict { deleted: false });
            }
            Some(_) => {}
        }
    }
    let bytes = buffer.encode(text);
    repo.host()
        .write_file(&repo.worktree_path(&buffer.path), &bytes)?;
    Ok(SaveOutcome::Saved(EditBuffer {
        text: text.to_owned(),
        on_disk: Fingerprint::of(&bytes),
        ..buffer.clone()
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_crlf_and_bom_through_an_edit() {
        let buffer = EditBuffer::from_bytes("a.txt", "\u{feff}a\r\nb\r\n".as_bytes()).unwrap();
        assert!(buffer.crlf && buffer.bom);
        assert_eq!(buffer.text, "a\nb\n");
        assert_eq!(buffer.encode("a\nc\n"), "\u{feff}a\r\nc\r\n".as_bytes());
        let mixed = EditBuffer::from_bytes("m.txt", b"a\r\nb\n").unwrap();
        assert!(!mixed.crlf);
        assert_eq!(mixed.encode(&mixed.text), b"a\r\nb\n");
        assert!(EditBuffer::from_bytes("x", &[0xff, 0xfe]).is_none());
    }
}
