use serde::{Deserialize, Serialize};

use crate::lines::{NumberedLine, contiguous_after, contiguous_before, index_of_line};
use crate::side::Side;

pub const CONTEXT_LINES: usize = 3;

/// The most lines one note may cover; every covered line is kept visible in the diff.
pub const MAX_RANGE_LINES: u32 = 1000;

/// Where a note sits: a line or a range of lines on one side, with the code it was made on and
/// a few lines around it, so it can be found again after the file changes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Anchor {
    #[serde(default)]
    pub side: Side,
    /// The line, or the first line of a range. 1-based.
    pub line: u32,
    /// The last line of a range; absent on a single line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    /// The text of every anchored line. Empty when only the line number is known (a hand-added
    /// note); the app fills it in from the file.
    #[serde(default)]
    pub code: Vec<String>,
    #[serde(default)]
    pub before: Vec<String>,
    #[serde(default)]
    pub after: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AnchorError {
    #[error("line {line} is not available on the {} side", side.as_str())]
    LineMissing { line: u32, side: Side },
    #[error("lines {line}–{end_line} are not all available on the {} side", side.as_str())]
    RangeMissing {
        line: u32,
        end_line: u32,
        side: Side,
    },
}

impl Anchor {
    /// A line-only anchor, as a hand-added note gives it.
    pub fn at_line(side: Side, line: u32, end_line: Option<u32>) -> Self {
        Self {
            side,
            line,
            end_line: end_line.filter(|end| *end > line),
            ..Self::default()
        }
    }

    pub fn last_line(&self) -> u32 {
        self.end_line.unwrap_or(self.line)
    }

    pub fn is_range(&self) -> bool {
        self.last_line() > self.line
    }

    /// The first anchored line's text.
    pub fn text(&self) -> &str {
        self.code.first().map_or("", String::as_str)
    }

    /// The text of every line the anchor covers; one empty line when only the number is known.
    pub fn anchored_text(&self) -> Vec<&str> {
        if self.code.is_empty() {
            vec![""]
        } else {
            self.code.iter().map(String::as_str).collect()
        }
    }

    /// Only the line number is known: no code and no context.
    pub fn is_line_only(&self) -> bool {
        self.before.is_empty()
            && self.after.is_empty()
            && self.code.len() <= 1
            && self.text().is_empty()
    }

    /// `12`, or `12–18` for a range.
    pub fn line_span(&self) -> String {
        if self.is_range() {
            format!("{}–{}", self.line, self.last_line())
        } else {
            self.line.to_string()
        }
    }

    /// `line 12`, or `lines 12–18` for a range.
    pub fn lines_label(&self) -> String {
        let noun = if self.is_range() { "lines" } else { "line" };
        format!("{noun} {}", self.line_span())
    }
}

/// Anchors `line` (through `end_line` for a range) on `lines`, capturing the code and up to
/// three lines of context each side.
pub fn create_anchor(
    lines: &[NumberedLine],
    line: u32,
    side: Side,
    end_line: Option<u32>,
) -> Result<Anchor, AnchorError> {
    let index = index_of_line(lines, line).ok_or(AnchorError::LineMissing { line, side })?;
    let end = end_line.unwrap_or(line);
    let end_index = (index + end.saturating_sub(line) as usize).min(lines.len());
    if end < line || lines.get(end_index).map(|entry| entry.line) != Some(end) {
        return Err(AnchorError::RangeMissing {
            line,
            end_line: end,
            side,
        });
    }
    let texts = |slice: &[NumberedLine]| slice.iter().map(|entry| entry.text.clone()).collect();
    Ok(Anchor {
        side,
        line,
        end_line: (end > line).then_some(end),
        code: texts(&lines[index..=end_index]),
        before: texts(contiguous_before(lines, index, CONTEXT_LINES)),
        after: texts(contiguous_after(lines, end_index, CONTEXT_LINES)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lines::number_lines;

    fn original() -> Vec<NumberedLine> {
        number_lines(
            &[
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
                "",
            ]
            .join("\n"),
        )
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn captures_the_line_and_three_context_lines_each_side() {
        assert_eq!(
            create_anchor(&original(), 5, Side::New, None).unwrap(),
            Anchor {
                side: Side::New,
                line: 5,
                end_line: None,
                code: strings(&["  for (const item of items) sum += item.price"]),
                before: strings(&["", "export function total(items) {", "  let sum = 0"]),
                after: strings(&["  return sum", "}", ""]),
            }
        );
    }

    #[test]
    fn clips_context_at_the_start_and_end_of_the_file() {
        let lines = original();
        assert!(
            create_anchor(&lines, 1, Side::Old, None)
                .unwrap()
                .before
                .is_empty()
        );
        assert!(
            create_anchor(&lines, 11, Side::Old, None)
                .unwrap()
                .after
                .is_empty()
        );
    }

    #[test]
    fn rejects_lines_that_do_not_exist() {
        assert_eq!(
            create_anchor(&original(), 99, Side::New, None),
            Err(AnchorError::LineMissing {
                line: 99,
                side: Side::New
            })
        );
    }

    #[test]
    fn captures_every_line_of_a_range_with_context_around_both_ends() {
        let lines = original();
        let range = create_anchor(&lines, 3, Side::New, Some(7)).unwrap();
        assert_eq!(
            range,
            Anchor {
                side: Side::New,
                line: 3,
                end_line: Some(7),
                code: lines[2..7].iter().map(|entry| entry.text.clone()).collect(),
                before: strings(&["import { a } from \"a\"", ""]),
                after: strings(&[
                    "",
                    "export function count(items) {",
                    "  return items.length"
                ]),
            }
        );
        assert_eq!(range.lines_label(), "lines 3–7");
    }

    #[test]
    fn keeps_a_one_line_range_a_plain_anchor() {
        let lines = original();
        assert_eq!(
            create_anchor(&lines, 5, Side::New, Some(5)),
            create_anchor(&lines, 5, Side::New, None)
        );
    }

    #[test]
    fn rejects_ranges_that_are_backwards_or_not_all_present() {
        let lines = original();
        assert!(create_anchor(&lines, 5, Side::New, Some(4)).is_err());
        assert!(create_anchor(&lines, 9, Side::New, Some(12)).is_err());
        let sparse: Vec<_> = lines.into_iter().filter(|entry| entry.line != 4).collect();
        assert!(create_anchor(&sparse, 3, Side::New, Some(5)).is_err());
    }

    #[test]
    fn labels_lines_and_ranges() {
        let single = Anchor::at_line(Side::New, 12, None);
        assert_eq!(single.lines_label(), "line 12");
        assert!(single.is_line_only());
        assert_eq!(
            Anchor::at_line(Side::New, 12, Some(18)).line_span(),
            "12–18"
        );
    }
}
