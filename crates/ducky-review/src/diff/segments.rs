use std::collections::{HashMap, HashSet};
use std::ops::Range;

use super::hunks::{DiffLine, LineKind};
use crate::side::Side;

pub const DEFAULT_CONTEXT: usize = 3;
/// Unchanged runs shorter than this stay inline instead of collapsing into a tiny gap.
const MIN_GAP: usize = 4;

/// A run of diff lines, as indexes into the line list: shown, or collapsed into a gap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment {
    Lines(Range<usize>),
    Gap { id: usize, lines: Range<usize> },
}

impl Segment {
    pub fn lines(&self) -> Range<usize> {
        match self {
            Self::Lines(lines) | Self::Gap { lines, .. } => lines.clone(),
        }
    }
}

/// A line on one side, e.g. to keep a noted line visible.
pub type LineKey = (Side, u32);

/// Shows each change with `context` lines around it and collapses the rest into gaps. Pinned
/// lines stay visible inside gaps.
pub fn build_segments(
    lines: &[DiffLine],
    context: usize,
    pinned: &HashSet<LineKey>,
) -> Vec<Segment> {
    let mut visible = vec![false; lines.len()];
    let is_pinned = |line: &DiffLine| {
        [Side::Old, Side::New].into_iter().any(|side| {
            line.line_on(side)
                .is_some_and(|number| pinned.contains(&(side, number)))
        })
    };
    for (index, line) in lines.iter().enumerate() {
        if !pinned.is_empty() && is_pinned(line) {
            visible[index] = true;
        }
        if line.kind == LineKind::Context {
            continue;
        }
        let to = (index + context).min(lines.len() - 1);
        visible[index.saturating_sub(context)..=to].fill(true);
    }

    let mut segments: Vec<Segment> = Vec::new();
    let mut gap_id = 0;
    let mut start = 0;
    while start < lines.len() {
        let shown = visible[start];
        let end = start + visible[start..].iter().take_while(|v| **v == shown).count();
        if !shown && end - start >= MIN_GAP {
            segments.push(Segment::Gap {
                id: gap_id,
                lines: start..end,
            });
            gap_id += 1;
        } else if let Some(Segment::Lines(last)) = segments.last_mut() {
            last.end = end;
        } else {
            segments.push(Segment::Lines(start..end));
        }
        start = end;
    }
    segments
}

/// How far a gap has been opened from its top and bottom edges.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GapExpansion {
    pub top: usize,
    pub bottom: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VisibleBlock {
    Lines(Range<usize>),
    Gap { id: usize, hidden: usize },
}

/// The segments with each gap opened as far as `expanded` says; revealed lines join their neighbours.
pub fn visible_blocks(
    segments: &[Segment],
    expanded: &HashMap<usize, GapExpansion>,
) -> Vec<VisibleBlock> {
    let mut blocks: Vec<VisibleBlock> = Vec::new();
    let push_lines = |blocks: &mut Vec<VisibleBlock>, range: Range<usize>| {
        if range.is_empty() {
            return;
        }
        if let Some(VisibleBlock::Lines(last)) = blocks.last_mut() {
            last.end = range.end;
        } else {
            blocks.push(VisibleBlock::Lines(range));
        }
    };
    for segment in segments {
        let (id, lines) = match segment {
            Segment::Lines(lines) => {
                push_lines(&mut blocks, lines.clone());
                continue;
            }
            Segment::Gap { id, lines } => (*id, lines.clone()),
        };
        let expansion = expanded.get(&id).copied().unwrap_or_default();
        let total = lines.len();
        let top = expansion.top.min(total);
        let bottom = expansion.bottom.min(total - top);
        push_lines(&mut blocks, lines.start..lines.start + top);
        let hidden = total - top - bottom;
        if hidden > 0 {
            blocks.push(VisibleBlock::Gap { id, hidden });
        }
        push_lines(&mut blocks, lines.end - bottom..lines.end);
    }
    blocks
}

/// Caps the rendered lines at `max_lines`; returns the kept blocks and how many lines were held back.
pub fn limit_blocks(blocks: &[VisibleBlock], max_lines: usize) -> (Vec<VisibleBlock>, usize) {
    let mut limited = Vec::new();
    let mut budget = max_lines;
    let mut remaining = 0;
    for block in blocks {
        match block {
            VisibleBlock::Gap { .. } => {
                if budget > 0 {
                    limited.push(block.clone());
                }
            }
            VisibleBlock::Lines(range) => {
                let shown = range.len().min(budget);
                if shown > 0 {
                    limited.push(VisibleBlock::Lines(range.start..range.start + shown));
                }
                remaining += range.len() - shown;
                budget -= shown;
            }
        }
    }
    (limited, remaining)
}

#[cfg(test)]
mod tests {
    use super::super::hunks::{LineOptions, build_lines, kinds};
    use super::*;

    fn numbered(count: usize) -> String {
        (1..=count).map(|i| format!("line {i}\n")).collect()
    }

    fn diff(old: &str, new: &str) -> Vec<DiffLine> {
        build_lines(old, new, LineOptions::default())
    }

    fn shape(segments: &[Segment]) -> Vec<(&'static str, usize)> {
        segments
            .iter()
            .map(|segment| match segment {
                Segment::Lines(lines) => ("lines", lines.len()),
                Segment::Gap { lines, .. } => ("gap", lines.len()),
            })
            .collect()
    }

    fn no_pins() -> HashSet<LineKey> {
        HashSet::new()
    }

    #[test]
    fn collapses_unchanged_context_beyond_the_window_into_gaps() {
        let old = numbered(30);
        let lines = diff(&old, &old.replace("line 15\n", "line fifteen\n"));
        let segments = build_segments(&lines, 3, &no_pins());
        assert_eq!(shape(&segments), [("gap", 11), ("lines", 8), ("gap", 12)]);
        assert_eq!(lines[segments[0].lines().start].old_no, Some(1));
        let middle = segments[1].lines();
        assert_eq!(lines[middle.start].old_no, Some(12));
        assert_eq!(kinds(&lines[middle]), "cccdaccc");
    }

    #[test]
    fn keeps_short_unchanged_runs_inline() {
        let old = numbered(12);
        let new = old
            .replace("line 2\n", "two\n")
            .replace("line 10\n", "ten\n");
        let segments = build_segments(&diff(&old, &new), 3, &no_pins());
        assert_eq!(segments.len(), 1);
        assert!(matches!(segments[0], Segment::Lines(_)));
    }

    #[test]
    fn merges_overlapping_context_between_nearby_changes() {
        let old = numbered(40);
        let new = old
            .replace("line 10\n", "ten\n")
            .replace("line 30\n", "thirty\n");
        let segments = build_segments(&diff(&old, &new), 3, &no_pins());
        let kinds: Vec<_> = shape(&segments).into_iter().map(|(kind, _)| kind).collect();
        assert_eq!(kinds, ["gap", "lines", "gap", "lines", "gap"]);
        let ids: Vec<_> = segments
            .iter()
            .filter_map(|segment| match segment {
                Segment::Gap { id, .. } => Some(*id),
                Segment::Lines(_) => None,
            })
            .collect();
        assert_eq!(ids, [0, 1, 2]);
    }

    #[test]
    fn collapses_an_unchanged_file_into_a_single_gap() {
        let text = numbered(10);
        assert_eq!(
            build_segments(&diff(&text, &text), DEFAULT_CONTEXT, &no_pins()),
            [Segment::Gap {
                id: 0,
                lines: 0..10
            }]
        );
    }

    #[test]
    fn returns_nothing_for_two_empty_files() {
        assert!(build_segments(&diff("", ""), DEFAULT_CONTEXT, &no_pins()).is_empty());
    }

    fn middle_change() -> (Vec<DiffLine>, Vec<Segment>) {
        let old = numbered(30);
        let lines = diff(&old, &old.replace("line 15\n", "fifteen\n"));
        let segments = build_segments(&lines, 3, &no_pins());
        (lines, segments)
    }

    fn block_shape(blocks: &[VisibleBlock]) -> Vec<String> {
        blocks
            .iter()
            .map(|block| match block {
                VisibleBlock::Gap { hidden, .. } => format!("gap:{hidden}"),
                VisibleBlock::Lines(lines) => format!("lines:{}", lines.len()),
            })
            .collect()
    }

    #[test]
    fn shows_gaps_collapsed_by_default() {
        let (_, segments) = middle_change();
        let blocks = visible_blocks(&segments, &HashMap::new());
        assert_eq!(block_shape(&blocks), ["gap:11", "lines:8", "gap:12"]);
    }

    #[test]
    fn reveals_lines_from_either_edge_and_merges_them_into_neighbouring_lines() {
        let (lines, segments) = middle_change();
        let expanded = HashMap::from([
            (0, GapExpansion { top: 0, bottom: 5 }),
            (1, GapExpansion { top: 2, bottom: 0 }),
        ]);
        let blocks = visible_blocks(&segments, &expanded);
        assert_eq!(block_shape(&blocks), ["gap:6", "lines:15", "gap:10"]);
        let VisibleBlock::Lines(middle) = &blocks[1] else {
            panic!("expected lines");
        };
        assert_eq!(lines[middle.start].old_no, Some(7));
    }

    #[test]
    fn drops_a_gap_once_fully_expanded() {
        let (_, segments) = middle_change();
        let expanded = HashMap::from([
            (
                0,
                GapExpansion {
                    top: 100,
                    bottom: 0,
                },
            ),
            (
                1,
                GapExpansion {
                    top: 0,
                    bottom: 100,
                },
            ),
        ]);
        assert_eq!(
            visible_blocks(&segments, &expanded),
            [VisibleBlock::Lines(0..31)]
        );
    }

    #[test]
    fn caps_rendered_lines_and_reports_how_many_were_held_back() {
        let segments = build_segments(&diff("", &numbered(50)), DEFAULT_CONTEXT, &no_pins());
        let blocks = visible_blocks(&segments, &HashMap::new());
        assert_eq!(
            limit_blocks(&blocks, 20),
            (vec![VisibleBlock::Lines(0..20)], 30)
        );
    }

    #[test]
    fn leaves_small_diffs_untouched() {
        let segments = build_segments(&diff("a\n", "b\n"), DEFAULT_CONTEXT, &no_pins());
        let blocks = visible_blocks(&segments, &HashMap::new());
        assert_eq!(limit_blocks(&blocks, 20), (blocks.clone(), 0));
    }

    #[test]
    fn keeps_pinned_lines_visible_inside_a_collapsed_gap() {
        let old = numbered(30);
        let lines = diff(&old, &old.replace("line 30", "line thirty"));
        assert!(matches!(
            build_segments(&lines, 3, &no_pins())[0],
            Segment::Gap { .. }
        ));
        let pinned = build_segments(&lines, 3, &HashSet::from([(Side::New, 10)]));
        let kinds: Vec<_> = shape(&pinned).into_iter().map(|(kind, _)| kind).collect();
        assert_eq!(kinds, ["gap", "lines", "gap", "lines"]);
        let numbers: Vec<_> = lines[pinned[1].lines()]
            .iter()
            .map(|line| line.new_no)
            .collect();
        assert_eq!(numbers, [Some(10)]);
    }

    #[test]
    fn segments_a_200k_line_added_file() {
        let text: String = (0..200_000).map(|i| format!("line {i}\n")).collect();
        let segments = build_segments(&diff("", &text), DEFAULT_CONTEXT, &no_pins());
        assert_eq!(segments, [Segment::Lines(0..200_000)]);
    }
}
