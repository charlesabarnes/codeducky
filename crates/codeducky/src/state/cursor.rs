//! The keyboard's line focus in a file's diff, in display order.

use ducky_review::Side;
use ducky_review::diff::LineKind;
use ducky_session::TextDiff;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct LinePos {
    pub side: Side,
    pub line: u32,
}

/// Every line as the unified view lists it: a removed line on the old side, the rest on the new.
pub fn positions(text: &TextDiff) -> Vec<LinePos> {
    text.lines
        .iter()
        .filter_map(|line| match line.kind {
            LineKind::Del => line.old_no.map(|line| LinePos {
                side: Side::Old,
                line,
            }),
            _ => line.new_no.map(|line| LinePos {
                side: Side::New,
                line,
            }),
        })
        .collect()
}

/// Indexes where a run of changed lines begins.
pub fn change_starts(text: &TextDiff) -> Vec<usize> {
    let changed: Vec<bool> = text
        .lines
        .iter()
        .map(|line| line.kind != LineKind::Context)
        .collect();
    (0..changed.len())
        .filter(|&i| changed[i] && (i == 0 || !changed[i - 1]))
        .collect()
}

pub fn index_of(positions: &[LinePos], at: LinePos) -> Option<usize> {
    positions.iter().position(|p| *p == at)
}

/// The first of `targets` after `from` (or before it, going back).
pub fn step_to(targets: &[usize], from: Option<usize>, forward: bool) -> Option<usize> {
    match (from, forward) {
        (None, true) => targets.first().copied(),
        (None, false) => targets.last().copied(),
        (Some(from), true) => targets.iter().copied().find(|&t| t > from),
        (Some(from), false) => targets.iter().rev().copied().find(|&t| t < from),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use ducky_review::diff::{LineOptions, build_lines};

    fn text(old: &str, new: &str) -> TextDiff {
        TextDiff {
            old_text: Some(old.into()),
            new_text: Some(new.into()),
            lines: build_lines(old, new, LineOptions::default()),
            moved: Vec::new(),
            old_lines: Arc::from([]),
            new_lines: Arc::from([]),
        }
    }

    #[test]
    fn lists_lines_and_change_runs_in_display_order() {
        let diff = text("a\nb\nc\nd\ne\n", "a\nB\nc\nd\nE\n");
        let at = positions(&diff);
        assert_eq!(at.len(), 7);
        assert_eq!(
            at[1],
            LinePos {
                side: Side::Old,
                line: 2
            }
        );
        assert_eq!(
            at[2],
            LinePos {
                side: Side::New,
                line: 2
            }
        );
        let starts = change_starts(&diff);
        assert_eq!(starts, [1, 5]);
        assert_eq!(step_to(&starts, Some(1), true), Some(5));
        assert_eq!(step_to(&starts, Some(5), true), None);
        assert_eq!(step_to(&starts, None, false), Some(5));
        assert_eq!(step_to(&starts, Some(5), false), Some(1));
    }
}
