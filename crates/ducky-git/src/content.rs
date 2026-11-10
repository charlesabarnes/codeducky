use ducky_host::HostError;

use crate::repo::Repo;
use crate::runner::{GitError, Result, parse_error, text};

/// Text sides past this are `TooLarge` unless asked otherwise.
pub const DEFAULT_MAX_BYTES: usize = 1 << 20;
/// Like git: a NUL in the first 8000 bytes makes it binary.
const BINARY_SNIFF_BYTES: usize = 8000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileSide {
    /// UTF-8 decoded lossily; line endings kept as they are.
    Text {
        text: String,
        size: u64,
    },
    Binary {
        size: u64,
    },
    TooLarge {
        size: u64,
    },
}

impl FileSide {
    pub fn from_bytes(bytes: &[u8], max_bytes: usize) -> Self {
        let size = bytes.len() as u64;
        if is_binary(bytes) {
            Self::Binary { size }
        } else if bytes.len() > max_bytes {
            Self::TooLarge { size }
        } else {
            Self::Text {
                text: text(bytes),
                size,
            }
        }
    }

    pub fn size(&self) -> u64 {
        match self {
            Self::Text { size, .. } | Self::Binary { size } | Self::TooLarge { size } => *size,
        }
    }
}

pub fn is_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobInfo {
    pub oid: String,
    pub size: u64,
}

impl Repo {
    /// The blob at `path` in `rev`; `None` when the path is not a file there (missing, a folder,
    /// a submodule).
    pub fn blob_at(&self, rev: &str, path: &str) -> Result<Option<BlobInfo>> {
        self.blob_info(&format!("{rev}:{path}"))
    }

    fn blob_info(&self, spec: &str) -> Result<Option<BlobInfo>> {
        if spec.contains('\n') {
            return Ok(None);
        }
        let args = [
            "cat-file",
            "--batch-check=%(objectname) %(objecttype) %(objectsize)",
        ];
        let out = text(
            &self
                .git
                .run_with(&args, Some(format!("{spec}\n").into_bytes()))?,
        );
        let fields: Vec<&str> = out.split_whitespace().collect();
        match fields[..] {
            [oid, "blob", size] => Ok(Some(BlobInfo {
                oid: oid.into(),
                size: size.parse().map_err(|_| parse_error(&args, out.clone()))?,
            })),
            _ => Ok(None),
        }
    }

    /// Exact bytes. Blobs over the host's 8 MiB output cap are [`GitError::TooLarge`].
    pub fn read_blob(&self, oid: &str) -> Result<Vec<u8>> {
        self.git.run(&["cat-file", "blob", oid])
    }

    /// Exact bytes of `path` at `rev`, or `None` when it is not a file there.
    pub fn read_at(&self, rev: &str, path: &str) -> Result<Option<Vec<u8>>> {
        match self.blob_at(rev, path)? {
            Some(blob) => self.read_blob(&blob.oid).map(Some),
            None => Ok(None),
        }
    }

    /// Exact bytes of `path` in the working tree, or `None` when it is not there.
    pub fn read_worktree(&self, path: &str) -> Result<Option<Vec<u8>>> {
        match self.git.host.read_file(&self.worktree_path(path)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(HostError::NotFound(_)) => Ok(None),
            Err(error) => Err(GitError::Host(error)),
        }
    }

    /// The absolute path of a worktree-relative one.
    pub fn worktree_path(&self, path: &str) -> String {
        format!("{}/{}", self.info().toplevel.trim_end_matches('/'), path)
    }

    /// Checks the size first, so a huge blob is never fetched; it is `TooLarge` without a binary
    /// check (use the change's `stats` for that).
    pub fn side_at(&self, rev: &str, path: &str, max_bytes: usize) -> Result<Option<FileSide>> {
        let Some(blob) = self.blob_at(rev, path)? else {
            return Ok(None);
        };
        if blob.size > max_bytes as u64 {
            return Ok(Some(FileSide::TooLarge { size: blob.size }));
        }
        Ok(Some(FileSide::from_bytes(
            &self.read_blob(&blob.oid)?,
            max_bytes,
        )))
    }

    /// Reads the whole file, then decides.
    pub fn side_in_worktree(&self, path: &str, max_bytes: usize) -> Result<Option<FileSide>> {
        Ok(self
            .read_worktree(path)?
            .map(|bytes| FileSide::from_bytes(&bytes, max_bytes)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sides_sniff_binary_before_size() {
        assert_eq!(
            FileSide::from_bytes(b"a\r\nb", 10),
            FileSide::Text {
                text: "a\r\nb".into(),
                size: 4
            }
        );
        assert_eq!(
            FileSide::from_bytes(b"a\0", 1),
            FileSide::Binary { size: 2 }
        );
        assert_eq!(
            FileSide::from_bytes(b"abc", 2),
            FileSide::TooLarge { size: 3 }
        );
        let mut late_nul = vec![b'a'; BINARY_SNIFF_BYTES];
        late_nul.push(0);
        assert!(!is_binary(&late_nul));
        assert_eq!(
            FileSide::from_bytes(b"", 0),
            FileSide::Text {
                text: String::new(),
                size: 0
            }
        );
    }
}
