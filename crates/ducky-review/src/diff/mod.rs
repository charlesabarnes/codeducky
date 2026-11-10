//! Line diffs for display: numbering, gaps, split rows, word changes and moved blocks.

pub mod hunks;
pub mod line_endings;
pub mod moved;
pub mod segments;
pub mod split;
pub mod word;

pub use hunks::{DiffLine, LineCounts, LineKind, LineOptions, build_lines, count_changes};
pub use line_endings::{LineEnding, LineEndingChange, line_ending, line_ending_change};
pub use moved::{
    MoveInput, MoveTarget, MovedIndex, MovedRange, changed_runs, detect_moved_blocks, moved_at,
};
pub use segments::{
    DEFAULT_CONTEXT, GapExpansion, LineKey, Segment, VisibleBlock, build_segments, limit_blocks,
    visible_blocks,
};
pub use split::{SplitRow, to_split_rows};
pub use word::{Piece, WordChanges, WordDiffer, layer_ranges, pair_changed_lines, word_changes};
