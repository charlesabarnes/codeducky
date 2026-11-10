use std::time::{Duration, Instant};

use similar::{Algorithm, DiffTag, capture_diff_slices_deadline};

use crate::side::Side;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LineKind {
    Context,
    Add,
    Del,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: LineKind,
    pub text: String,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    pub no_newline: bool,
    /// The base text of a context line that matched only when whitespace was ignored.
    pub old_text: Option<String>,
}

impl DiffLine {
    pub fn new(
        kind: LineKind,
        text: impl Into<String>,
        old_no: Option<u32>,
        new_no: Option<u32>,
    ) -> Self {
        Self {
            kind,
            text: text.into(),
            old_no,
            new_no,
            no_newline: false,
            old_text: None,
        }
    }

    /// The text as it reads on one side (context lines can differ in whitespace).
    pub fn text_on(&self, side: Side) -> &str {
        match (side, &self.old_text) {
            (Side::Old, Some(old)) => old,
            _ => &self.text,
        }
    }

    /// The line's number on one side; `None` when it does not exist there.
    pub fn line_on(&self, side: Side) -> Option<u32> {
        match (side, self.kind) {
            (Side::Old, LineKind::Add) | (Side::New, LineKind::Del) => None,
            (Side::Old, _) => self.old_no,
            (Side::New, _) => self.new_no,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LineOptions {
    /// Treat lines that differ only in whitespace as unchanged, like `git diff -w`.
    pub ignore_whitespace: bool,
}

const DIFF_TIMEOUT: Duration = Duration::from_secs(2);

struct RawLine<'a> {
    /// The line as stored, carriage return included, so line-ending changes still show.
    raw: &'a str,
    text: &'a str,
    no_newline: bool,
}

fn split_raw(value: &str) -> Vec<RawLine<'_>> {
    if value.is_empty() {
        return Vec::new();
    }
    let mut parts: Vec<&str> = value.split('\n').collect();
    let ends_with_newline = parts.last() == Some(&"");
    if ends_with_newline {
        parts.pop();
    }
    let last = parts.len() - 1;
    parts
        .into_iter()
        .enumerate()
        .map(|(index, raw)| RawLine {
            raw,
            text: raw.strip_suffix('\r').unwrap_or(raw),
            no_newline: !ends_with_newline && index == last,
        })
        .collect()
}

fn exact_key(line: &RawLine) -> String {
    if line.no_newline {
        format!("{}\0", line.raw)
    } else {
        line.raw.to_owned()
    }
}

fn whitespace_key(line: &RawLine) -> String {
    line.raw.chars().filter(|c| !c.is_whitespace()).collect()
}

/// A line diff of two texts, numbered on both sides. Within each change, removed lines come
/// before added ones.
pub fn build_lines(old_text: &str, new_text: &str, options: LineOptions) -> Vec<DiffLine> {
    let old_lines = split_raw(old_text);
    let new_lines = split_raw(new_text);
    let key = if options.ignore_whitespace {
        whitespace_key
    } else {
        exact_key
    };
    let old_keys: Vec<String> = old_lines.iter().map(key).collect();
    let new_keys: Vec<String> = new_lines.iter().map(key).collect();
    let ops = capture_diff_slices_deadline(
        Algorithm::Myers,
        &old_keys,
        &new_keys,
        Some(Instant::now() + DIFF_TIMEOUT),
    );

    let mut lines = Vec::with_capacity(old_lines.len().max(new_lines.len()));
    let mut pending_adds = Vec::new();
    let number = |index: usize| Some(index as u32 + 1);
    for op in ops {
        let (tag, old_range, new_range) = op.as_tag_tuple();
        if tag == DiffTag::Equal {
            lines.append(&mut pending_adds);
            for (old_index, new_index) in old_range.zip(new_range) {
                let (before, after) = (&old_lines[old_index], &new_lines[new_index]);
                lines.push(DiffLine {
                    no_newline: after.no_newline,
                    old_text: (before.text != after.text).then(|| before.text.to_owned()),
                    ..DiffLine::new(
                        LineKind::Context,
                        after.text,
                        number(old_index),
                        number(new_index),
                    )
                });
            }
            continue;
        }
        for index in old_range {
            let line = &old_lines[index];
            lines.push(DiffLine {
                no_newline: line.no_newline,
                ..DiffLine::new(LineKind::Del, line.text, number(index), None)
            });
        }
        for index in new_range {
            let line = &new_lines[index];
            pending_adds.push(DiffLine {
                no_newline: line.no_newline,
                ..DiffLine::new(LineKind::Add, line.text, None, number(index))
            });
        }
    }
    lines.append(&mut pending_adds);
    lines
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LineCounts {
    pub additions: u32,
    pub deletions: u32,
}

pub fn count_changes(old_text: &str, new_text: &str) -> LineCounts {
    let mut counts = LineCounts::default();
    for line in build_lines(old_text, new_text, LineOptions::default()) {
        match line.kind {
            LineKind::Add => counts.additions += 1,
            LineKind::Del => counts.deletions += 1,
            LineKind::Context => {}
        }
    }
    counts
}

#[cfg(test)]
pub(crate) fn kinds(lines: &[DiffLine]) -> String {
    lines
        .iter()
        .map(|line| match line.kind {
            LineKind::Context => 'c',
            LineKind::Add => 'a',
            LineKind::Del => 'd',
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(old: &str, new: &str) -> Vec<DiffLine> {
        build_lines(old, new, LineOptions::default())
    }

    fn ignoring_whitespace(old: &str, new: &str) -> Vec<DiffLine> {
        build_lines(
            old,
            new,
            LineOptions {
                ignore_whitespace: true,
            },
        )
    }

    #[test]
    fn numbers_context_added_and_removed_lines() {
        assert_eq!(
            lines("a\nb\nc\n", "a\nB\nc\nd\n"),
            [
                DiffLine::new(LineKind::Context, "a", Some(1), Some(1)),
                DiffLine::new(LineKind::Del, "b", Some(2), None),
                DiffLine::new(LineKind::Add, "B", None, Some(2)),
                DiffLine::new(LineKind::Context, "c", Some(3), Some(3)),
                DiffLine::new(LineKind::Add, "d", None, Some(4)),
            ]
        );
    }

    #[test]
    fn treats_an_empty_side_as_a_full_add_or_delete() {
        assert_eq!(kinds(&lines("", "x\ny\n")), "aa");
        assert_eq!(kinds(&lines("x\ny\n", "")), "dd");
    }

    #[test]
    fn flags_a_missing_trailing_newline() {
        assert_eq!(
            lines("a\n", "a"),
            [
                DiffLine::new(LineKind::Del, "a", Some(1), None),
                DiffLine {
                    no_newline: true,
                    ..DiffLine::new(LineKind::Add, "a", None, Some(1))
                },
            ]
        );
    }

    #[test]
    fn strips_carriage_returns_from_crlf_text() {
        let texts: Vec<_> = lines("a\r\n", "a\r\nb\r\n")
            .into_iter()
            .map(|line| line.text)
            .collect();
        assert_eq!(texts, ["a", "b"]);
    }

    #[test]
    fn counts_additions_and_deletions() {
        assert_eq!(
            count_changes("a\nb\nc\n", "a\nB\nc\nd\n"),
            LineCounts {
                additions: 2,
                deletions: 1
            }
        );
        assert_eq!(count_changes("same\n", "same\n"), LineCounts::default());
    }

    const OLD: &str = "function f() {\n  return 1\n}\n";
    const NEW: &str = "function f() {\n    return 1\n}\n";

    #[test]
    fn shows_indentation_changes_by_default() {
        assert_eq!(kinds(&lines(OLD, NEW)), "cdac");
    }

    #[test]
    fn ignoring_whitespace_keeps_both_texts_of_a_changed_context_line() {
        let lines = ignoring_whitespace(OLD, NEW);
        assert_eq!(kinds(&lines), "ccc");
        let body = &lines[1];
        assert_eq!((body.old_no, body.new_no), (Some(2), Some(2)));
        assert_eq!(body.text, "    return 1");
        assert_eq!(body.old_text.as_deref(), Some("  return 1"));
        assert_eq!(body.text_on(Side::Old), "  return 1");
        assert_eq!(body.text_on(Side::New), "    return 1");
        assert_eq!(lines[0].old_text, None);
    }

    #[test]
    fn ignoring_whitespace_keeps_line_numbers_right_around_real_changes() {
        let lines = ignoring_whitespace("a\n  b\nc\nd\n", "a\nb\nC\nd\ne\n");
        let numbered: Vec<_> = lines.iter().map(|l| (l.kind, l.old_no, l.new_no)).collect();
        assert_eq!(
            numbered,
            [
                (LineKind::Context, Some(1), Some(1)),
                (LineKind::Context, Some(2), Some(2)),
                (LineKind::Del, Some(3), None),
                (LineKind::Add, None, Some(3)),
                (LineKind::Context, Some(4), Some(4)),
                (LineKind::Add, None, Some(5)),
            ]
        );
    }

    #[test]
    fn ignoring_whitespace_ignores_spaces_inside_a_line_and_crlf() {
        assert_eq!(kinds(&ignoring_whitespace("a = b + c\r\n", "a=b+c\n")), "c");
    }

    #[test]
    fn ignoring_whitespace_still_shows_added_blank_lines() {
        assert_eq!(kinds(&ignoring_whitespace("a\nb\n", "a\n\nb\n")), "cac");
    }

    #[test]
    fn line_on_reads_each_side() {
        let added = DiffLine::new(LineKind::Add, "x", None, Some(4));
        assert_eq!(
            (added.line_on(Side::Old), added.line_on(Side::New)),
            (None, Some(4))
        );
    }
}
