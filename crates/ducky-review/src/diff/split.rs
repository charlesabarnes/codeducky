use super::hunks::{DiffLine, LineKind};

/// One row of the side-by-side view, as indexes into the line list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SplitRow {
    pub left: Option<usize>,
    pub right: Option<usize>,
}

/// Pairs each run's removed lines with its added lines, side by side; context sits on both sides.
pub fn to_split_rows(lines: &[DiffLine]) -> Vec<SplitRow> {
    let mut rows = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].kind == LineKind::Context {
            rows.push(SplitRow {
                left: Some(i),
                right: Some(i),
            });
            i += 1;
            continue;
        }
        let dels = run(lines, i, LineKind::Del);
        let adds = run(lines, dels.end, LineKind::Add);
        i = adds.end;
        for row in 0..dels.len().max(adds.len()) {
            rows.push(SplitRow {
                left: (row < dels.len()).then(|| dels.start + row),
                right: (row < adds.len()).then(|| adds.start + row),
            });
        }
    }
    rows
}

fn run(lines: &[DiffLine], start: usize, kind: LineKind) -> std::ops::Range<usize> {
    let len = lines[start..]
        .iter()
        .take_while(|line| line.kind == kind)
        .count();
    start..start + len
}

#[cfg(test)]
mod tests {
    use super::super::hunks::{LineOptions, build_lines};
    use super::*;

    fn text(lines: &[DiffLine], index: Option<usize>) -> Option<&str> {
        index.map(|index| lines[index].text.as_str())
    }

    #[test]
    fn pairs_removed_and_added_lines_side_by_side() {
        let lines = build_lines("a\nb\nc\nd\n", "a\nB\nC\nX\nY\nd\n", LineOptions::default());
        let rows: Vec<_> = to_split_rows(&lines)
            .into_iter()
            .map(|row| (text(&lines, row.left), text(&lines, row.right)))
            .collect();
        assert_eq!(
            rows,
            [
                (Some("a"), Some("a")),
                (Some("b"), Some("B")),
                (Some("c"), Some("C")),
                (None, Some("X")),
                (None, Some("Y")),
                (Some("d"), Some("d")),
            ]
        );
    }

    #[test]
    fn leaves_the_right_side_empty_for_pure_deletions() {
        let lines = build_lines("a\nb\n", "a\n", LineOptions::default());
        let row = to_split_rows(&lines)[1];
        assert_eq!(row.right, None);
        let left = &lines[row.left.unwrap()];
        assert_eq!((left.text.as_str(), left.kind), ("b", LineKind::Del));
    }
}
