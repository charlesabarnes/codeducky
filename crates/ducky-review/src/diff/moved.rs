use std::collections::HashMap;

use super::hunks::{DiffLine, LineKind};
use crate::side::Side;

/// Where the other half of a moved block is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoveTarget {
    pub path: String,
    pub side: Side,
    pub line: u32,
}

/// A run of removed (old) or added (new) lines that reappears elsewhere; inclusive line numbers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MovedRange {
    pub side: Side,
    pub start: u32,
    pub end: u32,
    pub other: MoveTarget,
}

/// Moved ranges per path.
pub type MovedIndex = HashMap<String, Vec<MovedRange>>;

#[derive(Debug, Clone, Copy)]
pub struct MoveInput<'a> {
    pub path: &'a str,
    pub lines: &'a [DiffLine],
}

/// Like git's `--color-moved`: a block needs at least this many non-blank lines…
pub const MIN_MOVED_LINES: usize = 3;
/// …and this many letters and digits, so runs of closing braces never count.
const MIN_ALNUM: usize = 20;
/// Lines that occur more often than this are poor block starts (e.g. a common import).
const MAX_CANDIDATES: usize = 64;
/// Above this many diff lines in total, detection is skipped to keep scans fast.
pub const MAX_MOVE_LINES: usize = 200_000;

struct Removed<'a> {
    path: &'a str,
    line: u32,
    text: &'a str,
    /// The run of consecutive removed lines it belongs to.
    run: usize,
}

struct Added<'a> {
    line: u32,
    text: &'a str,
}

fn is_blank(text: &str) -> bool {
    text.trim().is_empty()
}

fn alnum_count(text: &str) -> usize {
    text.chars().filter(|c| c.is_alphanumeric()).count()
}

/// Runs of `kind` lines; context ends a run, lines of the other change kind do not.
fn runs_of(lines: &[DiffLine], kind: LineKind) -> Vec<Vec<&DiffLine>> {
    let mut runs: Vec<Vec<&DiffLine>> = Vec::new();
    let mut open = false;
    for line in lines {
        if line.kind != kind {
            if line.kind == LineKind::Context {
                open = false;
            }
            continue;
        }
        if !open {
            runs.push(Vec::new());
            open = true;
        }
        runs.last_mut().expect("a run was opened").push(line);
    }
    runs
}

fn collect_removed<'a>(
    files: &[MoveInput<'a>],
) -> (Vec<Removed<'a>>, HashMap<&'a str, Vec<usize>>) {
    let mut removed = Vec::new();
    let mut index: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut run = 0;
    for file in files {
        for line_run in runs_of(file.lines, LineKind::Del) {
            for line in line_run {
                if !is_blank(&line.text) {
                    index.entry(&line.text).or_default().push(removed.len());
                }
                removed.push(Removed {
                    path: file.path,
                    line: line.old_no.unwrap_or_default(),
                    text: &line.text,
                    run,
                });
            }
            run += 1;
        }
    }
    (removed, index)
}

struct Match {
    from: usize,
    length: usize,
    non_blank: usize,
}

fn longest_match(
    added: &[Added],
    at: usize,
    removed: &[Removed],
    candidates: &[usize],
    used: &[bool],
) -> Option<Match> {
    let mut best: Option<Match> = None;
    for &from in candidates.iter().take(MAX_CANDIDATES) {
        let mut length = 0;
        let mut non_blank = 0;
        while at + length < added.len()
            && from + length < removed.len()
            && !used[from + length]
            && removed[from + length].run == removed[from].run
            && removed[from + length].text == added[at + length].text
        {
            if !is_blank(added[at + length].text) {
                non_blank += 1;
            }
            length += 1;
        }
        while length > 0 && is_blank(added[at + length - 1].text) {
            length -= 1;
        }
        if best.as_ref().is_none_or(|best| non_blank > best.non_blank) {
            best = Some(Match {
                from,
                length,
                non_blank,
            });
        }
    }
    best
}

fn qualifies(added: &[Added], at: usize, found: &Match) -> bool {
    if found.non_blank < MIN_MOVED_LINES {
        return false;
    }
    let mut alnum = 0;
    for entry in &added[at..at + found.length] {
        if alnum >= MIN_ALNUM {
            break;
        }
        alnum += alnum_count(entry.text);
    }
    alnum >= MIN_ALNUM
}

/// Finds blocks removed in one place and added in another, within a file or across files.
/// Greedy, like git: each added line starts the longest unused identical run of removed lines.
pub fn detect_moved_blocks(files: &[MoveInput]) -> MovedIndex {
    let total: usize = files.iter().map(|file| file.lines.len()).sum();
    if total > MAX_MOVE_LINES {
        return MovedIndex::new();
    }
    let (removed, index) = collect_removed(files);
    let mut used = vec![false; removed.len()];
    let mut result = MovedIndex::new();

    for file in files {
        for run in runs_of(file.lines, LineKind::Add) {
            let added: Vec<Added> = run
                .iter()
                .map(|line| Added {
                    line: line.new_no.unwrap_or_default(),
                    text: &line.text,
                })
                .collect();
            let mut at = 0;
            while at < added.len() {
                let candidates = (!is_blank(added[at].text))
                    .then(|| index.get(added[at].text))
                    .flatten();
                let found = candidates
                    .and_then(|candidates| longest_match(&added, at, &removed, candidates, &used));
                let Some(found) = found.filter(|found| qualifies(&added, at, found)) else {
                    at += 1;
                    continue;
                };
                let source = &removed[found.from];
                let source_end = removed[found.from + found.length - 1].line;
                let target = added[at].line;
                result
                    .entry(file.path.to_owned())
                    .or_default()
                    .push(MovedRange {
                        side: Side::New,
                        start: target,
                        end: added[at + found.length - 1].line,
                        other: MoveTarget {
                            path: source.path.to_owned(),
                            side: Side::Old,
                            line: source.line,
                        },
                    });
                result
                    .entry(source.path.to_owned())
                    .or_default()
                    .push(MovedRange {
                        side: Side::Old,
                        start: source.line,
                        end: source_end,
                        other: MoveTarget {
                            path: file.path.to_owned(),
                            side: Side::New,
                            line: target,
                        },
                    });
                used[found.from..found.from + found.length].fill(true);
                at += found.length;
            }
        }
    }
    for ranges in result.values_mut() {
        ranges.sort_by_key(|range| (range.side, range.start));
    }
    result
}

/// The moved range covering a line on one side, if any.
pub fn moved_at(ranges: Option<&[MovedRange]>, side: Side, line: u32) -> Option<&MovedRange> {
    ranges?
        .iter()
        .find(|range| range.side == side && (range.start..=range.end).contains(&line))
}

/// The changed lines, with each stretch of context squeezed to one line so runs stay apart.
pub fn changed_runs(lines: &[DiffLine]) -> Vec<&DiffLine> {
    let mut kept: Vec<&DiffLine> = Vec::new();
    for line in lines {
        let after_context = kept
            .last()
            .is_some_and(|last| last.kind == LineKind::Context);
        if line.kind != LineKind::Context || !after_context {
            kept.push(line);
        }
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::super::hunks::{LineOptions, build_lines};
    use super::*;

    const BLOCK: [&str; 4] = [
        "export function total(items) {",
        "  const sum = items.reduce((a, b) => a + b, 0)",
        "  return Math.round(sum * 100) / 100",
        "}",
    ];

    fn text(lines: &[&str]) -> String {
        lines.iter().map(|line| format!("{line}\n")).collect()
    }

    fn diff(old: &[&str], new: &[&str]) -> Vec<DiffLine> {
        build_lines(&text(old), &text(new), LineOptions::default())
    }

    fn joined<'a>(parts: &[&[&'a str]]) -> Vec<&'a str> {
        parts.iter().flat_map(|part| part.iter().copied()).collect()
    }

    fn target(path: &str, side: Side, line: u32) -> MoveTarget {
        MoveTarget {
            path: path.into(),
            side,
            line,
        }
    }

    #[test]
    fn finds_a_block_moved_within_a_file() {
        let rest: Vec<String> = ["a", "b", "c", "d", "e", "f"]
            .iter()
            .enumerate()
            .map(|(i, name)| format!("export const {name} = {i}"))
            .collect();
        let rest: Vec<&str> = rest.iter().map(String::as_str).collect();
        let before = joined(&[&["// header"], &BLOCK, &[""], &rest]);
        let after = joined(&[&["// header"], &rest, &[""], &BLOCK]);
        let lines = diff(&before, &after);
        let moved = detect_moved_blocks(&[MoveInput {
            path: "src/math.ts",
            lines: &lines,
        }]);
        let ranges = &moved["src/math.ts"];
        let removed = ranges.iter().find(|r| r.side == Side::Old).unwrap();
        let added = ranges.iter().find(|r| r.side == Side::New).unwrap();
        assert_eq!((removed.start, removed.end), (2, 5));
        assert_eq!(removed.other, target("src/math.ts", Side::New, 9));
        assert_eq!((added.start, added.end), (9, 12));
        assert_eq!(added.other, target("src/math.ts", Side::Old, 2));
        assert_eq!(moved_at(Some(ranges), Side::Old, 4), Some(removed));
        assert_eq!(moved_at(Some(ranges), Side::New, 8), None);
    }

    #[test]
    fn finds_a_block_moved_to_another_file() {
        let a = diff(
            &joined(&[&["import x"], &BLOCK, &["tail"]]),
            &["import x", "tail"],
        );
        let b = diff(&["head"], &joined(&[&["head"], &BLOCK]));
        let moved = detect_moved_blocks(&[
            MoveInput {
                path: "src/a.ts",
                lines: &a,
            },
            MoveInput {
                path: "src/b.ts",
                lines: &b,
            },
        ]);
        assert_eq!(
            moved["src/a.ts"],
            [MovedRange {
                side: Side::Old,
                start: 2,
                end: 5,
                other: target("src/b.ts", Side::New, 2)
            }]
        );
        assert_eq!(
            moved["src/b.ts"],
            [MovedRange {
                side: Side::New,
                start: 2,
                end: 5,
                other: target("src/a.ts", Side::Old, 2)
            }]
        );
    }

    fn moved_between(block: &[&str]) -> MovedIndex {
        let mut old = vec!["x"];
        old.extend(block);
        let a = diff(&old, &["x"]);
        let b = diff(&[], block);
        detect_moved_blocks(&[
            MoveInput {
                path: "a.ts",
                lines: &a,
            },
            MoveInput {
                path: "b.ts",
                lines: &b,
            },
        ])
    }

    #[test]
    fn ignores_blocks_shorter_than_three_non_blank_lines() {
        assert!(moved_between(&BLOCK[1..3]).is_empty());
    }

    #[test]
    fn ignores_runs_of_punctuation_such_as_closing_braces() {
        assert!(moved_between(&["    }", "  }", "}"]).is_empty());
    }

    #[test]
    fn does_not_count_blank_lines_toward_the_minimum() {
        assert!(moved_between(&[BLOCK[1], "", BLOCK[2], ""]).is_empty());
    }

    #[test]
    fn uses_each_removed_line_once() {
        let a = diff(&BLOCK, &[]);
        let b = diff(&[], &BLOCK);
        let c = diff(&[], &BLOCK);
        let moved = detect_moved_blocks(&[
            MoveInput {
                path: "a.ts",
                lines: &a,
            },
            MoveInput {
                path: "b.ts",
                lines: &b,
            },
            MoveInput {
                path: "c.ts",
                lines: &c,
            },
        ]);
        assert_eq!(moved["b.ts"].len(), 1);
        assert!(!moved.contains_key("c.ts"));
    }

    #[test]
    fn squeezes_context_between_changed_runs() {
        let lines = diff(&["a", "b", "c", "d"], &["A", "b", "c", "D"]);
        let kinds: Vec<_> = changed_runs(&lines).iter().map(|line| line.kind).collect();
        assert_eq!(
            kinds,
            [
                LineKind::Del,
                LineKind::Add,
                LineKind::Context,
                LineKind::Del,
                LineKind::Add
            ]
        );
    }
}
