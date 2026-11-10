/// One line of a file, or of a patch side whose lines may be sparse (hunks only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumberedLine {
    pub line: u32,
    pub text: String,
}

impl NumberedLine {
    pub fn new(line: u32, text: impl Into<String>) -> Self {
        Self {
            line,
            text: text.into(),
        }
    }
}

/// Splits on `\n`, dropping one trailing empty line and each line's trailing `\r`.
pub fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut parts: Vec<&str> = text.split('\n').collect();
    if parts.last() == Some(&"") {
        parts.pop();
    }
    parts
        .into_iter()
        .map(|part| part.strip_suffix('\r').unwrap_or(part))
        .collect()
}

pub fn number_lines(text: &str) -> Vec<NumberedLine> {
    split_lines(text)
        .into_iter()
        .zip(1..)
        .map(|(text, line)| NumberedLine::new(line, text))
        .collect()
}

/// The index of `line` in lines sorted by number.
pub fn index_of_line(lines: &[NumberedLine], line: u32) -> Option<usize> {
    lines.binary_search_by_key(&line, |entry| entry.line).ok()
}

/// Up to `count` lines right before `index`, stopping at a gap in the numbering.
pub fn contiguous_before(lines: &[NumberedLine], index: usize, count: usize) -> &[NumberedLine] {
    let mut start = index;
    while start > 0 && index - start < count && lines[start - 1].line + 1 == lines[start].line {
        start -= 1;
    }
    &lines[start..index]
}

/// Up to `count` lines right after `index`, stopping at a gap in the numbering.
pub fn contiguous_after(lines: &[NumberedLine], index: usize, count: usize) -> &[NumberedLine] {
    let mut end = index + 1;
    while end < lines.len() && end - index - 1 < count && lines[end].line == lines[end - 1].line + 1
    {
        end += 1;
    }
    &lines[index + 1..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_without_the_trailing_newline_or_carriage_returns() {
        assert!(split_lines("").is_empty());
        assert_eq!(split_lines("a\r\nb\n"), ["a", "b"]);
        assert_eq!(split_lines("a\n\n"), ["a", ""]);
        assert_eq!(split_lines("a"), ["a"]);
    }

    #[test]
    fn context_stops_at_gaps() {
        let lines = vec![
            NumberedLine::new(1, "a"),
            NumberedLine::new(2, "b"),
            NumberedLine::new(5, "c"),
            NumberedLine::new(6, "d"),
            NumberedLine::new(7, "e"),
        ];
        assert_eq!(index_of_line(&lines, 6), Some(3));
        assert_eq!(index_of_line(&lines, 3), None);
        assert_eq!(contiguous_before(&lines, 3, 3), &lines[2..3]);
        assert_eq!(contiguous_after(&lines, 1, 3), &[]);
        assert_eq!(contiguous_after(&lines, 2, 1), &lines[3..4]);
        assert_eq!(contiguous_before(&lines, 1, 3), &lines[0..1]);
    }
}
