use super::quote;
use super::{DiffLine, FileDiff, Hunk, LineKind};
use crate::model::{ChangeStatus, Mode};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PatchError {
    #[error("line {line}: bad hunk header {text:?}")]
    HunkHeader { line: usize, text: String },
    #[error("line {line}: {text:?} does not fit the hunk")]
    HunkLine { line: usize, text: String },
    /// The input ended inside a hunk: it was cut short.
    #[error("the diff ends inside a hunk of {path}")]
    Truncated { path: String },
}

pub fn parse_patch(input: &[u8]) -> Result<Vec<FileDiff>, PatchError> {
    let mut parser = Parser::default();
    for (index, line) in lines(input).enumerate() {
        parser.line(index + 1, line)?;
    }
    parser.finish()
}

fn lines(input: &[u8]) -> impl Iterator<Item = &[u8]> {
    let input = input.strip_suffix(b"\n").unwrap_or(input);
    input
        .split(|b| *b == b'\n')
        .filter(move |_| !input.is_empty())
}

#[derive(Default)]
struct Parser {
    files: Vec<FileDiff>,
    current: Option<FileDiff>,
    /// Lines still due in the open hunk: (old, new).
    due: (u32, u32),
    next: (u32, u32),
    /// Inside a combined diff, which this parser does not model.
    skipping: bool,
}

fn new_file(old_path: Option<String>, new_path: Option<String>) -> FileDiff {
    FileDiff {
        old_path,
        new_path,
        status: ChangeStatus::Modified,
        old_mode: None,
        new_mode: None,
        similarity: None,
        dissimilarity: None,
        old_oid: None,
        new_oid: None,
        binary: false,
        hunks: Vec::new(),
    }
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

impl Parser {
    fn line(&mut self, number: usize, line: &[u8]) -> Result<(), PatchError> {
        if self.due != (0, 0) {
            return self.hunk_line(number, line);
        }
        if let Some(rest) = line.strip_prefix(b"diff --git ") {
            self.close();
            self.skipping = false;
            let (old, new) = header_paths(rest);
            self.current = Some(new_file(old, new));
            return Ok(());
        }
        if line.starts_with(b"diff --cc ") || line.starts_with(b"diff --combined ") {
            self.close();
            self.skipping = true;
            return Ok(());
        }
        if self.skipping {
            return Ok(());
        }
        let Some(file) = self.current.as_mut() else {
            return Ok(());
        };
        if line.starts_with(b"@@ ") {
            return self.hunk_header(number, line);
        }
        if line.starts_with(b"\\") {
            self.mark_no_newline();
            return Ok(());
        }
        extended_header(file, line);
        Ok(())
    }

    fn hunk_header(&mut self, number: usize, line: &[u8]) -> Result<(), PatchError> {
        let bad = || PatchError::HunkHeader {
            line: number,
            text: lossy(line),
        };
        let text = lossy(line);
        let rest = text.strip_prefix("@@ -").ok_or_else(bad)?;
        let (ranges, section) = rest.split_once(" @@").ok_or_else(bad)?;
        let (old, new) = ranges.split_once(" +").ok_or_else(bad)?;
        let (old_start, old_lines) = range(old).ok_or_else(bad)?;
        let (new_start, new_lines) = range(new).ok_or_else(bad)?;
        self.due = (old_lines, new_lines);
        self.next = (old_start.max(1), new_start.max(1));
        let file = self.current.as_mut().ok_or_else(bad)?;
        file.hunks.push(Hunk {
            old_start,
            old_lines,
            new_start,
            new_lines,
            section: section.trim().to_owned(),
            lines: Vec::new(),
        });
        Ok(())
    }

    fn hunk_line(&mut self, number: usize, line: &[u8]) -> Result<(), PatchError> {
        let bad = || PatchError::HunkLine {
            line: number,
            text: lossy(line),
        };
        if line.starts_with(b"\\") {
            self.mark_no_newline();
            return Ok(());
        }
        let (marker, text) = line
            .split_first()
            .map_or((b' ', &b""[..]), |(m, t)| (*m, t));
        let (old, new) = self.next;
        let (kind, old_line, new_line) = match marker {
            b' ' if self.due.0 > 0 && self.due.1 > 0 => {
                self.due = (self.due.0 - 1, self.due.1 - 1);
                self.next = (old + 1, new + 1);
                (LineKind::Context, Some(old), Some(new))
            }
            b'-' if self.due.0 > 0 => {
                self.due.0 -= 1;
                self.next.0 += 1;
                (LineKind::Removed, Some(old), None)
            }
            b'+' if self.due.1 > 0 => {
                self.due.1 -= 1;
                self.next.1 += 1;
                (LineKind::Added, None, Some(new))
            }
            _ => return Err(bad()),
        };
        let hunk = self
            .current
            .as_mut()
            .and_then(|f| f.hunks.last_mut())
            .ok_or_else(bad)?;
        hunk.lines.push(DiffLine {
            kind,
            text: lossy(text),
            old_line,
            new_line,
            no_newline: false,
        });
        Ok(())
    }

    fn mark_no_newline(&mut self) {
        let last = self
            .current
            .as_mut()
            .and_then(|f| f.hunks.last_mut())
            .and_then(|h| h.lines.last_mut());
        if let Some(last) = last {
            last.no_newline = true;
        }
    }

    fn close(&mut self) {
        if let Some(mut file) = self.current.take() {
            match file.status {
                ChangeStatus::Added => file.old_path = None,
                ChangeStatus::Deleted => file.new_path = None,
                _ => {}
            }
            self.files.push(file);
        }
    }

    fn finish(mut self) -> Result<Vec<FileDiff>, PatchError> {
        if self.due != (0, 0) {
            let path = self
                .current
                .as_ref()
                .map(|f| f.path().to_owned())
                .unwrap_or_default();
            return Err(PatchError::Truncated { path });
        }
        self.close();
        Ok(self.files)
    }
}

/// `start,count` or `start` (a count of one).
fn range(text: &str) -> Option<(u32, u32)> {
    match text.split_once(',') {
        Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
        None => Some((text.parse().ok()?, 1)),
    }
}

fn extended_header(file: &mut FileDiff, line: &[u8]) {
    let text = lossy(line);
    let mode = |value: &str| Mode::parse(value.trim());
    if let Some(value) = text.strip_prefix("old mode ") {
        file.old_mode = mode(value);
    } else if let Some(value) = text.strip_prefix("new mode ") {
        file.new_mode = mode(value);
    } else if let Some(value) = text.strip_prefix("new file mode ") {
        file.status = ChangeStatus::Added;
        file.new_mode = mode(value);
    } else if let Some(value) = text.strip_prefix("deleted file mode ") {
        file.status = ChangeStatus::Deleted;
        file.old_mode = mode(value);
    } else if let Some(value) = text.strip_prefix("similarity index ") {
        file.similarity = value.trim_end_matches('%').parse().ok();
    } else if let Some(value) = text.strip_prefix("dissimilarity index ") {
        file.dissimilarity = value.trim_end_matches('%').parse().ok();
    } else if line.starts_with(b"rename from ") {
        file.status = ChangeStatus::Renamed;
        file.old_path = Some(quote::path(&line[12..]));
    } else if line.starts_with(b"rename to ") {
        file.new_path = Some(quote::path(&line[10..]));
    } else if line.starts_with(b"copy from ") {
        file.status = ChangeStatus::Copied;
        file.old_path = Some(quote::path(&line[10..]));
    } else if line.starts_with(b"copy to ") {
        file.new_path = Some(quote::path(&line[8..]));
    } else if let Some(value) = text.strip_prefix("index ") {
        index_line(file, value);
    } else if line.starts_with(b"Binary files ") || line == b"GIT binary patch" {
        file.binary = true;
    } else if let Some(path) = line.strip_prefix(b"--- ") {
        match side_path(path, b"a/") {
            Some(path) => file.old_path = Some(path),
            None => {
                file.old_path = None;
                file.status = ChangeStatus::Added;
            }
        }
    } else if let Some(path) = line.strip_prefix(b"+++ ") {
        match side_path(path, b"b/") {
            Some(path) => file.new_path = Some(path),
            None => {
                file.new_path = None;
                file.status = ChangeStatus::Deleted;
            }
        }
    }
}

fn index_line(file: &mut FileDiff, value: &str) {
    let mut parts = value.split(' ');
    if let Some((old, new)) = parts.next().and_then(|ids| ids.split_once("..")) {
        let id = |oid: &str| Some(oid.to_owned()).filter(|o| !crate::repo::is_null_oid(o));
        file.old_oid = id(old);
        file.new_oid = id(new);
    }
    if let Some(mode) = parts.next().and_then(Mode::parse) {
        file.old_mode.get_or_insert(mode);
        file.new_mode.get_or_insert(mode);
    }
}

/// A `---`/`+++` path: `None` for `/dev/null`. Git adds a tab after a path with a space in it.
fn side_path(path: &[u8], prefix: &[u8]) -> Option<String> {
    let path = path.strip_suffix(b"\t").unwrap_or(path);
    if path == b"/dev/null" {
        return None;
    }
    let path = match quote::unquote(path) {
        Some((bytes, _)) => bytes,
        None => path.to_vec(),
    };
    Some(lossy(path.strip_prefix(prefix).unwrap_or(&path)))
}

/// The two paths of `diff --git a/X b/Y`. Unquoted paths with spaces are ambiguous; the
/// same-path reading is tried first, and later header lines correct the rest.
fn header_paths(rest: &[u8]) -> (Option<String>, Option<String>) {
    let strip = |bytes: &[u8], prefix: &[u8]| lossy(bytes.strip_prefix(prefix).unwrap_or(bytes));
    if let Some((old, tail)) = quote::unquote(rest) {
        let tail = tail.strip_prefix(b" ").unwrap_or(tail);
        let new = quote::unquote(tail).map_or_else(|| tail.to_vec(), |(bytes, _)| bytes);
        return (Some(strip(&old, b"a/")), Some(strip(&new, b"b/")));
    }
    if let Some(at) = find(rest, b" \"b/") {
        let new = quote::unquote(&rest[at + 1..]).map_or_else(Vec::new, |(bytes, _)| bytes);
        return (Some(strip(&rest[..at], b"a/")), Some(strip(&new, b"b/")));
    }
    if rest.len() >= 5 && rest.len() % 2 == 1 {
        let half = rest.len() / 2;
        let (old, new) = (&rest[..half], &rest[half + 1..]);
        if rest[half] == b' '
            && old.starts_with(b"a/")
            && new.starts_with(b"b/")
            && old[2..] == new[2..]
        {
            return (Some(strip(old, b"a/")), Some(strip(new, b"b/")));
        }
    }
    match find(rest, b" b/") {
        Some(at) => (
            Some(strip(&rest[..at], b"a/")),
            Some(strip(&rest[at + 1..], b"b/")),
        ),
        None => (None, None),
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests;
