use crate::anchor::{Anchor, CONTEXT_LINES};
use crate::lines::{NumberedLine, contiguous_after, contiguous_before};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchKind {
    /// The code and all of its context read the same.
    Exact,
    Nearest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AnchorMatch {
    pub index: usize,
    pub line: u32,
    /// The last line matched: `line` itself unless the anchor is a range.
    pub end_line: u32,
    pub kind: MatchKind,
    pub context_score: usize,
}

/// The parts of an anchor matching looks at, borrowed so a range's ends can be matched alone.
struct Probe<'a> {
    line: u32,
    text: Vec<&'a str>,
    before: Vec<&'a str>,
    after: Vec<&'a str>,
}

impl<'a> Probe<'a> {
    fn of(anchor: &'a Anchor) -> Self {
        Self {
            line: anchor.line,
            text: anchor.anchored_text(),
            before: anchor.before.iter().map(String::as_str).collect(),
            after: anchor.after.iter().map(String::as_str).collect(),
        }
    }
}

fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn context_score(probe: &Probe, lines: &[NumberedLine], index: usize, end_index: usize) -> usize {
    let before = contiguous_before(lines, index, probe.before.len());
    let after = contiguous_after(lines, end_index, probe.after.len());
    let before_hits = before
        .iter()
        .rev()
        .zip(probe.before.iter().rev())
        .filter(|(entry, want)| normalize(&entry.text) == normalize(want))
        .count();
    let after_hits = after
        .iter()
        .zip(&probe.after)
        .filter(|(entry, want)| normalize(&entry.text) == normalize(want))
        .count();
    before_hits + after_hits
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Block {
    Exact,
    Loose,
}

/// Whether `text` reads at `index` onwards on consecutive lines; exact when not even whitespace differs.
fn block_at(
    lines: &[NumberedLine],
    index: usize,
    text: &[&str],
    targets: &[String],
) -> Option<Block> {
    let first = lines[index].line;
    let mut block = Block::Exact;
    for (k, (want, target)) in text.iter().zip(targets).enumerate() {
        let entry = lines.get(index + k)?;
        if entry.line != first + k as u32 {
            return None;
        }
        if entry.text != *want {
            if normalize(&entry.text) != *target {
                return None;
            }
            block = Block::Loose;
        }
    }
    Some(block)
}

struct Candidate {
    found: AnchorMatch,
    exact_text: bool,
    distance: u32,
}

impl Candidate {
    fn beats(&self, other: &Self) -> bool {
        if self.found.context_score != other.found.context_score {
            return self.found.context_score > other.found.context_score;
        }
        if self.exact_text != other.exact_text {
            return self.exact_text;
        }
        self.distance < other.distance
    }
}

/// The anchored lines read the same, in one piece; the best context agreement wins, then the nearest.
fn match_block(probe: &Probe, lines: &[NumberedLine]) -> Option<AnchorMatch> {
    let targets: Vec<String> = probe.text.iter().map(|text| normalize(text)).collect();
    let blank = targets.iter().all(String::is_empty);
    let full_score = probe.before.len() + probe.after.len();
    let mut best: Option<Candidate> = None;
    for (index, entry) in lines.iter().enumerate() {
        let Some(found) = block_at(lines, index, &probe.text, &targets) else {
            continue;
        };
        let end_index = index + probe.text.len() - 1;
        let score = context_score(probe, lines, index, end_index);
        if blank && score == 0 {
            continue;
        }
        let exact_text = found == Block::Exact;
        let candidate = Candidate {
            found: AnchorMatch {
                index,
                line: entry.line,
                end_line: lines[end_index].line,
                kind: if score == full_score && exact_text {
                    MatchKind::Exact
                } else {
                    MatchKind::Nearest
                },
                context_score: score,
            },
            exact_text,
            distance: entry.line.abs_diff(probe.line),
        };
        if best.as_ref().is_none_or(|best| candidate.beats(best)) {
            best = Some(candidate);
        }
    }
    best.map(|candidate| candidate.found)
}

/// A range whose inside changed: each end is matched on its own, with the lines inside the range
/// as its inner context. Both ends must be found, in order, on one run of consecutive lines, each
/// agreeing with some of its context.
fn match_ends(anchor: &Anchor, lines: &[NumberedLine]) -> Option<AnchorMatch> {
    let text = anchor.anchored_text();
    let last = text.len() - 1;
    let first = match_block(
        &Probe {
            line: anchor.line,
            text: vec![text[0]],
            before: anchor.before.iter().map(String::as_str).collect(),
            after: text[1..(1 + CONTEXT_LINES).min(text.len())].to_vec(),
        },
        lines,
    )?;
    let end = match_block(
        &Probe {
            line: anchor.last_line(),
            text: vec![text[last]],
            before: text[last.saturating_sub(CONTEXT_LINES)..last].to_vec(),
            after: anchor.after.iter().map(String::as_str).collect(),
        },
        lines,
    )?;
    if end.line <= first.line || first.context_score == 0 || end.context_score == 0 {
        return None;
    }
    if (end.index - first.index) as u32 != end.line - first.line {
        return None;
    }
    Some(AnchorMatch {
        index: first.index,
        line: first.line,
        end_line: end.line,
        kind: MatchKind::Nearest,
        context_score: first.context_score + end.context_score,
    })
}

/// Finds the anchor's lines in `lines`, which may be a whole file or the sparse lines of a patch
/// side. Candidates must carry the anchor's code; the best context agreement wins, then the
/// nearest line. A range is found whole where it is intact, otherwise by its two ends, so it
/// follows lines added or removed inside it.
pub fn match_anchor(anchor: &Anchor, lines: &[NumberedLine]) -> Option<AnchorMatch> {
    let block = match_block(&Probe::of(anchor), lines);
    if block.is_some() || !anchor.is_range() || anchor.code.is_empty() {
        return block;
    }
    match_ends(anchor, lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anchor::create_anchor;
    use crate::lines::number_lines;
    use crate::side::Side;

    fn file(lines: &[&str]) -> Vec<NumberedLine> {
        number_lines(&format!("{}\n", lines.join("\n")))
    }

    const ORIGINAL: [&str; 11] = [
        "import { a } from \"a\"",
        "",
        "export function total(items) {",
        "  let sum = 0",
        "  for (const item of items) sum += item.price",
        "  return sum",
        "}",
        "",
        "export function count(items) {",
        "  return items.length",
        "}",
    ];

    fn original() -> Vec<NumberedLine> {
        file(&ORIGINAL)
    }

    fn with(prefix: &[&str], rest: &[&str]) -> Vec<NumberedLine> {
        let all: Vec<&str> = prefix.iter().chain(rest).copied().collect();
        file(&all)
    }

    fn anchor(line: u32) -> Anchor {
        create_anchor(&original(), line, Side::New, None).unwrap()
    }

    fn found(result: Option<AnchorMatch>) -> (u32, MatchKind) {
        let found = result.expect("a match");
        (found.line, found.kind)
    }

    #[test]
    fn matches_exactly_in_place() {
        let found = match_anchor(&anchor(5), &original()).unwrap();
        assert_eq!(
            (found.line, found.kind, found.context_score),
            (5, MatchKind::Exact, 6)
        );
    }

    #[test]
    fn follows_the_line_when_code_is_inserted_above_it() {
        let edited = with(&["// header", "// more"], &ORIGINAL);
        assert_eq!(
            found(match_anchor(&anchor(5), &edited)),
            (7, MatchKind::Exact)
        );
    }

    #[test]
    fn prefers_the_duplicate_whose_context_matches_over_the_nearer_one() {
        let on_return = anchor(10);
        assert_eq!(on_return.text(), "  return items.length");
        let edited = with(
            &[
                "export function count(items) {",
                "  return items.length",
                "}",
            ],
            &ORIGINAL,
        );
        assert_eq!(
            found(match_anchor(&on_return, &edited)),
            (13, MatchKind::Exact)
        );
    }

    #[test]
    fn falls_back_to_the_nearest_line_with_the_same_text_when_the_context_changed() {
        let lonely =
            create_anchor(&file(&["a", "b", "target", "c", "d"]), 3, Side::New, None).unwrap();
        let edited = file(&["target", "x", "y", "z", "q", "r", "target", "w"]);
        let found = match_anchor(&lonely, &edited).unwrap();
        assert_eq!(
            (found.line, found.kind, found.context_score),
            (1, MatchKind::Nearest, 0)
        );
    }

    #[test]
    fn tolerates_reindentation() {
        let edited = file(&[
            "export function total(items) {",
            "    let sum = 0",
            "    for (const item of items) sum += item.price",
            "    return sum",
            "}",
        ]);
        assert_eq!(
            found(match_anchor(&anchor(5), &edited)),
            (3, MatchKind::Nearest)
        );
    }

    #[test]
    fn returns_none_when_the_line_text_is_gone() {
        let edited: Vec<&str> = ORIGINAL
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != 4)
            .map(|(_, text)| *text)
            .collect();
        assert_eq!(
            match_anchor(&anchor(5), &number_lines(&edited.join("\n"))),
            None
        );
    }

    #[test]
    fn does_not_anchor_blank_lines_without_any_matching_context() {
        let blank = anchor(8);
        assert_eq!(match_anchor(&blank, &file(&["x", "", "y"])), None);
        assert_eq!(
            found(match_anchor(&blank, &original())),
            (8, MatchKind::Exact)
        );
    }

    #[test]
    fn works_on_sparse_lines_and_ignores_context_across_gaps() {
        let sparse = vec![
            NumberedLine::new(40, "  let sum = 0"),
            NumberedLine::new(41, "  for (const item of items) sum += item.price"),
            NumberedLine::new(42, "  return sum"),
            NumberedLine::new(90, "  for (const item of items) sum += item.price"),
        ];
        let found = match_anchor(&anchor(5), &sparse).unwrap();
        assert_eq!((found.index, found.line, found.context_score), (1, 41, 2));
    }

    fn range() -> Anchor {
        create_anchor(&original(), 3, Side::New, Some(7)).unwrap()
    }

    #[test]
    fn finds_an_intact_range_where_it_moved() {
        let edited = with(&["// header", "// more"], &ORIGINAL);
        let found = match_anchor(&range(), &edited).unwrap();
        assert_eq!(
            (found.line, found.end_line, found.kind),
            (5, 9, MatchKind::Exact)
        );
    }

    #[test]
    fn follows_both_ends_when_lines_are_added_inside_the_range() {
        let mut texts = vec!["// header"];
        texts.extend(&ORIGINAL[..4]);
        texts.push("  if (!items) return 0");
        texts.extend(&ORIGINAL[4..]);
        let found = match_anchor(&range(), &file(&texts)).unwrap();
        assert_eq!(
            (found.line, found.end_line, found.kind),
            (4, 9, MatchKind::Nearest)
        );
    }

    #[test]
    fn follows_both_ends_when_a_line_inside_the_range_is_removed() {
        let texts: Vec<&str> = ORIGINAL[..3]
            .iter()
            .chain(&ORIGINAL[4..])
            .copied()
            .collect();
        let found = match_anchor(&range(), &file(&texts)).unwrap();
        assert_eq!((found.line, found.end_line), (3, 6));
    }

    #[test]
    fn a_range_is_not_found_when_an_end_is_gone() {
        let texts: Vec<&str> = ORIGINAL[..2]
            .iter()
            .chain(&ORIGINAL[3..])
            .copied()
            .collect();
        assert_eq!(match_anchor(&range(), &file(&texts)), None);
    }

    #[test]
    fn a_range_is_not_found_across_lines_that_are_not_consecutive() {
        let sparse: Vec<_> = original()
            .into_iter()
            .filter(|entry| entry.line != 5)
            .collect();
        assert_eq!(match_anchor(&range(), &sparse), None);
    }
}
