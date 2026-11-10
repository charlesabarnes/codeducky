use std::collections::HashMap;
use std::ops::Range;

use similar::{Algorithm, DiffTag, capture_diff_slices};

use super::hunks::{DiffLine, LineKind};

/// Byte ranges of a line's text that changed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WordChanges {
    pub old: Vec<Range<usize>>,
    pub new: Vec<Range<usize>>,
}

/// Lines longer than this (in characters) are not word-diffed: the cost grows quickly and the
/// result is rarely readable.
pub const MAX_WORD_DIFF_CHARS: usize = 1000;
/// Below this share of unchanged characters, highlighting words only adds noise.
const MIN_UNCHANGED_SHARE: f64 = 0.3;

/// Pairs removed lines with added lines the way GitHub does: within each run of changes, the
/// n-th removed line goes with the n-th added line, both ways. Lines `skip` accepts (moved
/// blocks) are left out. Keys and values are indexes into `lines`.
pub fn pair_changed_lines(
    lines: &[DiffLine],
    skip: impl Fn(usize) -> bool,
) -> HashMap<usize, usize> {
    let mut partners = HashMap::new();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].kind == LineKind::Context {
            i += 1;
            continue;
        }
        let mut collect = |kind: LineKind| {
            let mut kept = Vec::new();
            while i < lines.len() && lines[i].kind == kind {
                if !skip(i) {
                    kept.push(i);
                }
                i += 1;
            }
            kept
        };
        let dels = collect(LineKind::Del);
        let adds = collect(LineKind::Add);
        for (del, add) in dels.into_iter().zip(adds) {
            partners.insert(del, add);
            partners.insert(add, del);
        }
    }
    partners
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric()
        || c == '_'
        || matches!(c as u32,
            0xAD | 0xC0..=0xD6 | 0xD8..=0xF6 | 0xF8..=0x2C6 | 0x2C8..=0x2D7 | 0x2DE..=0x2FF | 0x1E00..=0x1EFF)
}

fn is_inline_space(c: char) -> bool {
    c.is_whitespace() && c != '\n' && c != '\r'
}

/// Words, runs of spaces, newlines and single other characters, as jsdiff's `diffWordsWithSpace` splits them.
fn tokenize(text: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let mut rest = text;
    while let Some(first) = rest.chars().next() {
        let len = if rest.starts_with("\r\n") {
            2
        } else if is_word_char(first) {
            rest.find(|c| !is_word_char(c)).unwrap_or(rest.len())
        } else if is_inline_space(first) {
            rest.find(|c| !is_inline_space(c)).unwrap_or(rest.len())
        } else {
            first.len_utf8()
        };
        tokens.push(&rest[..len]);
        rest = &rest[len..];
    }
    tokens
}

fn push_range(ranges: &mut Vec<Range<usize>>, range: Range<usize>) {
    match ranges.last_mut() {
        Some(last) if last.end == range.start => last.end = range.end,
        _ => ranges.push(range),
    }
}

/// The changed words between two versions of a line, or `None` when they should not be highlighted.
pub fn word_changes(old_text: &str, new_text: &str) -> Option<WordChanges> {
    if old_text == new_text
        || old_text.chars().count() > MAX_WORD_DIFF_CHARS
        || new_text.chars().count() > MAX_WORD_DIFF_CHARS
    {
        return None;
    }
    let old_tokens = tokenize(old_text);
    let new_tokens = tokenize(new_text);
    let offsets = |tokens: &[&str]| -> Vec<usize> {
        let mut at = 0;
        let mut offsets = vec![0];
        offsets.extend(tokens.iter().map(|token| {
            at += token.len();
            at
        }));
        offsets
    };
    let (old_at, new_at) = (offsets(&old_tokens), offsets(&new_tokens));
    let mut result = WordChanges::default();
    let mut unchanged = 0;
    for op in capture_diff_slices(Algorithm::Myers, &old_tokens, &new_tokens) {
        let (tag, old, new) = op.as_tag_tuple();
        if tag == DiffTag::Equal {
            let run = &old_text[old_at[old.start]..old_at[old.end]];
            if !run.trim().is_empty() {
                unchanged += run.chars().count();
            }
            continue;
        }
        if !old.is_empty() {
            push_range(&mut result.old, old_at[old.start]..old_at[old.end]);
        }
        if !new.is_empty() {
            push_range(&mut result.new, new_at[new.start]..new_at[new.end]);
        }
    }
    let longest = old_text
        .trim()
        .chars()
        .count()
        .max(new_text.trim().chars().count());
    if longest == 0 || (unchanged as f64) / (longest as f64) < MIN_UNCHANGED_SHARE {
        return None;
    }
    Some(WordChanges {
        old: bridge_spaces(old_text, result.old),
        new: bridge_spaces(new_text, result.new),
    })
}

/// Joins changed words separated only by whitespace, so `a b` → `x y` reads as one change.
fn bridge_spaces(text: &str, ranges: Vec<Range<usize>>) -> Vec<Range<usize>> {
    let mut joined: Vec<Range<usize>> = Vec::new();
    for range in ranges {
        match joined.last_mut() {
            Some(last) if text[last.end..range.start].trim().is_empty() => last.end = range.end,
            _ => joined.push(range),
        }
    }
    joined
}

/// Word changes per line of a diff, computed only when a line asks (as it renders) and kept.
pub struct WordDiffer<'a> {
    lines: &'a [DiffLine],
    partners: HashMap<usize, usize>,
    cache: HashMap<usize, Option<Vec<Range<usize>>>>,
}

impl<'a> WordDiffer<'a> {
    pub fn new(lines: &'a [DiffLine], skip: impl Fn(usize) -> bool) -> Self {
        Self {
            lines,
            partners: pair_changed_lines(lines, skip),
            cache: HashMap::new(),
        }
    }

    /// The changed byte ranges of line `index`, or `None` when it is unpaired or not worth highlighting.
    pub fn ranges(&mut self, index: usize) -> Option<&[Range<usize>]> {
        if !self.cache.contains_key(&index) {
            self.compute(index);
        }
        self.cache.get(&index).and_then(Option::as_deref)
    }

    fn compute(&mut self, index: usize) {
        let Some(&partner) = self.partners.get(&index) else {
            self.cache.insert(index, None);
            return;
        };
        let (del, add) = if self.lines[index].kind == LineKind::Del {
            (index, partner)
        } else {
            (partner, index)
        };
        let changes = word_changes(&self.lines[del].text, &self.lines[add].text);
        let (old, new) = changes.map_or((None, None), |changes| {
            (Some(changes.old), Some(changes.new))
        });
        self.cache.insert(del, old);
        self.cache.insert(add, new);
    }
}

/// A piece of a line: a token, or part of one, and whether it lies in a changed range.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Piece<'a, S> {
    pub text: &'a str,
    pub style: Option<S>,
    pub changed: bool,
}

/// Splits syntax-highlighted tokens (or the plain text when there are none) at the edges of the
/// changed ranges, so the word highlight layers over the token styles without touching them.
pub fn layer_ranges<'a, S: Clone>(
    tokens: Option<&[(&'a str, S)]>,
    text: &'a str,
    ranges: &[Range<usize>],
) -> Vec<Piece<'a, S>> {
    let plain = [(text, None)];
    let styled: Vec<(&str, Option<S>)>;
    let source: &[(&str, Option<S>)] = match tokens {
        Some(tokens) => {
            styled = tokens
                .iter()
                .map(|(text, style)| (*text, Some(style.clone())))
                .collect();
            &styled
        }
        None => &plain,
    };
    let mut pieces = Vec::new();
    let mut offset = 0;
    let mut r = 0;
    for (content, style) in source {
        let end = offset + content.len();
        let mut at = offset;
        while at < end {
            while r < ranges.len() && ranges[r].end <= at {
                r += 1;
            }
            let (next, changed) = match ranges.get(r) {
                Some(range) if range.start < end && range.start <= at => (range.end.min(end), true),
                Some(range) if range.start < end => (range.start, false),
                _ => (end, false),
            };
            pieces.push(Piece {
                text: &content[at - offset..next - offset],
                style: style.clone(),
                changed,
            });
            at = next;
        }
        offset = end;
    }
    pieces
}

#[cfg(test)]
mod tests {
    use super::super::hunks::{LineOptions, build_lines};
    use super::*;

    fn lines(old: &str, new: &str) -> Vec<DiffLine> {
        build_lines(old, new, LineOptions::default())
    }

    fn find(lines: &[DiffLine], kind: LineKind, text: &str) -> usize {
        lines
            .iter()
            .position(|l| l.kind == kind && l.text == text)
            .unwrap()
    }

    fn marked<'a>(text: &'a str, ranges: &[Range<usize>]) -> Vec<&'a str> {
        ranges.iter().map(|range| &text[range.clone()]).collect()
    }

    #[test]
    fn pairs_the_nth_removed_line_with_the_nth_added_line_in_each_run() {
        let lines = lines("a\nb\nc\nx\nd\n", "a\nB\nC\nD2\nx\n");
        let partners = pair_changed_lines(&lines, |_| false);
        let partner_text = |index: usize| partners.get(&index).map(|p| lines[*p].text.as_str());
        assert_eq!(partner_text(find(&lines, LineKind::Del, "b")), Some("B"));
        assert_eq!(partner_text(find(&lines, LineKind::Del, "c")), Some("C"));
        assert_eq!(partner_text(find(&lines, LineKind::Del, "d")), None);
        assert_eq!(partner_text(find(&lines, LineKind::Add, "B")), Some("b"));
    }

    #[test]
    fn leaves_unmatched_extra_lines_unpaired() {
        let lines = lines("one\n", "uno\ndos\n");
        let partners = pair_changed_lines(&lines, |_| false);
        assert_eq!(partners.len(), 2);
        assert!(!partners.contains_key(&find(&lines, LineKind::Add, "dos")));
    }

    #[test]
    fn marks_only_the_changed_words_on_each_side() {
        let (old, new) = (
            "const total = subtotal + tax",
            "const total = subtotal + tax - discount",
        );
        let changes = word_changes(old, new).unwrap();
        assert!(marked(old, &changes.old).is_empty());
        assert_eq!(marked(new, &changes.new), [" - discount"]);
    }

    #[test]
    fn marks_a_replaced_identifier_on_both_sides() {
        let (old, new) = ("retry(attempt, delay)", "retry(attempt, backoff)");
        let changes = word_changes(old, new).unwrap();
        assert_eq!(marked(old, &changes.old), ["delay"]);
        assert_eq!(marked(new, &changes.new), ["backoff"]);
    }

    #[test]
    fn skips_very_long_lines() {
        let long = "x ".repeat(MAX_WORD_DIFF_CHARS);
        assert_eq!(word_changes(&long, &format!("{long}y")), None);
    }

    #[test]
    fn skips_lines_that_share_almost_nothing() {
        assert_eq!(
            word_changes("import { a } from \"b\"", "return computeEverything()"),
            None
        );
    }

    #[test]
    fn bridges_whitespace_between_changed_words() {
        assert_eq!(
            word_changes("foo bar baz qux", "foo BAR BAZ qux")
                .unwrap()
                .new,
            vec![Range { start: 4, end: 11 }]
        );
    }

    #[test]
    fn differ_returns_ranges_for_paired_lines_only() {
        let lines = lines("let a = 1\nkeep\n", "let a = 2\nkeep\nextra line\n");
        let del = find(&lines, LineKind::Del, "let a = 1");
        let add = find(&lines, LineKind::Add, "let a = 2");
        let extra = find(&lines, LineKind::Add, "extra line");
        let mut differ = WordDiffer::new(&lines, |_| false);
        assert_eq!(marked(&lines[add].text, differ.ranges(add).unwrap()), ["2"]);
        assert_eq!(marked(&lines[del].text, differ.ranges(del).unwrap()), ["1"]);
        assert_eq!(differ.ranges(extra), None);
    }

    #[test]
    fn splits_tokens_at_range_edges_and_keeps_their_styles() {
        let tokens = [("const ", 'a'), ("total", 'b'), (" = 2", 'c')];
        let pieces = layer_ranges(Some(&tokens), "const total = 2", &[8..11, 14..15]);
        let flat: Vec<_> = pieces
            .iter()
            .map(|p| (p.text, p.style, p.changed))
            .collect();
        assert_eq!(
            flat,
            [
                ("const ", Some('a'), false),
                ("to", Some('b'), false),
                ("tal", Some('b'), true),
                (" = ", Some('c'), false),
                ("2", Some('c'), true),
            ]
        );
    }

    #[test]
    fn layers_plain_text_without_tokens() {
        let pieces = layer_ranges::<()>(None, "abc", &[Range { start: 1, end: 2 }]);
        let flat: Vec<_> = pieces.iter().map(|p| (p.text, p.changed)).collect();
        assert_eq!(flat, [("a", false), ("b", true), ("c", false)]);
    }

    #[test]
    fn pairs_around_lines_that_moved() {
        let lines = lines("keep\nmoved away\nold value 1\n", "keep\nnew value 2\n");
        let moved = find(&lines, LineKind::Del, "moved away");
        let partners = pair_changed_lines(&lines, |index| index == moved);
        let old = find(&lines, LineKind::Del, "old value 1");
        assert_eq!(lines[partners[&old]].text, "new value 2");
        assert!(!partners.contains_key(&moved));
    }

    #[test]
    fn pairs_a_200k_line_run() {
        let lines: Vec<_> = (0..200_000u32)
            .map(|i| DiffLine::new(LineKind::Add, format!("x{i}"), None, Some(i + 1)))
            .collect();
        assert!(pair_changed_lines(&lines, |_| false).is_empty());
    }

    #[test]
    fn tokenizes_like_jsdiff() {
        assert_eq!(
            tokenize("a_b  c(d)\r\né"),
            ["a_b", "  ", "c", "(", "d", ")", "\r\n", "é"]
        );
    }
}
