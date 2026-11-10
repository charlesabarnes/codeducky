//! Unified-diff hunks as GitHub returns them per file of a pull request.

use std::sync::LazyLock;

use regex::Regex;

use crate::diff::{DiffLine, LineKind};
use crate::lines::NumberedLine;
use crate::side::Side;

static HUNK_HEADER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@").expect("static pattern")
});

enum Row<'a> {
    Context(&'a str),
    Del(&'a str),
    Add(&'a str),
}

/// Walks a patch's hunk lines with their numbers on both sides.
fn rows(patch: &str, mut visit: impl FnMut(Row, u32, u32)) {
    let mut rows: Vec<&str> = patch.split('\n').collect();
    if rows.last() == Some(&"") {
        rows.pop();
    }
    let (mut left, mut right) = (0, 0);
    let mut in_hunk = false;
    for raw in rows {
        if let Some(header) = HUNK_HEADER.captures(raw) {
            left = header[1].parse().unwrap_or(0);
            right = header[2].parse().unwrap_or(0);
            in_hunk = true;
            continue;
        }
        if !in_hunk || raw.starts_with('\\') {
            continue;
        }
        let text = raw.get(1..).unwrap_or("");
        match raw.chars().next() {
            Some('-') => {
                visit(Row::Del(text), left, right);
                left += 1;
            }
            Some('+') => {
                visit(Row::Add(text), left, right);
                right += 1;
            }
            Some(' ') | None => {
                visit(Row::Context(text), left, right);
                left += 1;
                right += 1;
            }
            Some(_) => {}
        }
    }
}

/// One side's lines as far as the hunks show them: sparse, with their real numbers.
pub fn patch_side_lines(patch: &str, side: Side) -> Vec<NumberedLine> {
    let mut lines = Vec::new();
    rows(patch, |row, left, right| match (row, side) {
        (Row::Context(text), Side::Old) | (Row::Del(text), Side::Old) => {
            lines.push(NumberedLine::new(left, text));
        }
        (Row::Context(text), Side::New) | (Row::Add(text), Side::New) => {
            lines.push(NumberedLine::new(right, text));
        }
        _ => {}
    });
    lines
}

/// A patch as diff lines numbered on both sides (hunks only, no gaps).
pub fn patch_diff_lines(patch: &str) -> Vec<DiffLine> {
    let mut lines = Vec::new();
    rows(patch, |row, left, right| {
        lines.push(match row {
            Row::Del(text) => DiffLine::new(LineKind::Del, text, Some(left), None),
            Row::Add(text) => DiffLine::new(LineKind::Add, text, None, Some(right)),
            Row::Context(text) => DiffLine::new(LineKind::Context, text, Some(left), Some(right)),
        });
    });
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anchor::create_anchor;
    use crate::lines::number_lines;
    use crate::matching::match_anchor;

    const PATCH: &str = "@@ -1,4 +1,5 @@\n one\n-two\n+TWO\n+two and a half\n three\n four\n@@ -20,2 +21,3 @@ function x() {\n twenty\n+added\n twenty-one\n\\ No newline at end of file";

    #[test]
    fn numbers_the_new_side() {
        let lines: Vec<_> = patch_side_lines(PATCH, Side::New)
            .into_iter()
            .map(|line| (line.line, line.text))
            .collect();
        let expected = [
            (1, "one"),
            (2, "TWO"),
            (3, "two and a half"),
            (4, "three"),
            (5, "four"),
            (21, "twenty"),
            (22, "added"),
            (23, "twenty-one"),
        ]
        .map(|(line, text)| (line, text.to_owned()));
        assert_eq!(lines, expected);
    }

    #[test]
    fn numbers_the_old_side() {
        let numbers: Vec<_> = patch_side_lines(PATCH, Side::Old)
            .iter()
            .map(|l| l.line)
            .collect();
        assert_eq!(numbers, [1, 2, 3, 4, 20, 21]);
    }

    #[test]
    fn lets_a_working_tree_anchor_map_onto_the_patch() {
        let mut texts = vec![
            "one".to_owned(),
            "TWO".into(),
            "two and a half".into(),
            "three".into(),
            "four".into(),
        ];
        texts.extend((0..15).map(|i| format!("filler {i}")));
        texts.extend(["twenty".into(), "added".into(), "twenty-one".into()]);
        let work_tree = number_lines(&texts.join("\n"));
        let anchor = create_anchor(&work_tree, 22, Side::New, None).unwrap();
        let found = match_anchor(&anchor, &patch_side_lines(PATCH, Side::New)).unwrap();
        assert_eq!(found.line, 22);
    }

    #[test]
    fn numbers_both_sides_and_skips_no_newline_markers_and_a_trailing_blank() {
        assert_eq!(
            patch_diff_lines("@@ -3,3 +3,3 @@ fn\n a\n-b\n+B\n\\ No newline at end of file\n c\n"),
            [
                DiffLine::new(LineKind::Context, "a", Some(3), Some(3)),
                DiffLine::new(LineKind::Del, "b", Some(4), None),
                DiffLine::new(LineKind::Add, "B", None, Some(4)),
                DiffLine::new(LineKind::Context, "c", Some(5), Some(5)),
            ]
        );
    }
}
