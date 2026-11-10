#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
    Lf,
    CrLf,
    Mixed,
}

/// The line-ending style of `text`, or `None` when it has no line breaks.
pub fn line_ending(text: &str) -> Option<LineEnding> {
    let bytes = text.as_bytes();
    let (mut crlf, mut lf) = (0, 0);
    for (i, _) in bytes.iter().enumerate().filter(|(_, byte)| **byte == b'\n') {
        if i > 0 && bytes[i - 1] == b'\r' {
            crlf += 1;
        } else {
            lf += 1;
        }
    }
    match (crlf, lf) {
        (0, 0) => None,
        (0, _) => Some(LineEnding::Lf),
        (_, 0) => Some(LineEnding::CrLf),
        _ => Some(LineEnding::Mixed),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineEndingChange {
    pub from: LineEnding,
    pub to: LineEnding,
    /// The texts are otherwise identical.
    pub only: bool,
}

/// How the line endings changed between two versions of a file, or `None` if they did not. The
/// diff hides carriage returns, so without this a CRLF switch reads as every line removed and
/// re-added with the same text.
pub fn line_ending_change(old_text: &str, new_text: &str) -> Option<LineEndingChange> {
    let (from, to) = (line_ending(old_text)?, line_ending(new_text)?);
    if from == to {
        return None;
    }
    Some(LineEndingChange {
        from,
        to,
        only: old_text.replace("\r\n", "\n") == new_text.replace("\r\n", "\n"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_the_style() {
        for (text, expected) in [
            ("", None),
            ("one line", None),
            ("a\nb\n", Some(LineEnding::Lf)),
            ("a\r\nb\r\n", Some(LineEnding::CrLf)),
            ("\r\n", Some(LineEnding::CrLf)),
            ("a\r\nb\n", Some(LineEnding::Mixed)),
            ("\n", Some(LineEnding::Lf)),
        ] {
            assert_eq!(line_ending(text), expected, "{text:?}");
        }
    }

    #[test]
    fn reports_a_switch_that_changes_nothing_else() {
        let change = |from, to, only| Some(LineEndingChange { from, to, only });
        assert_eq!(
            line_ending_change("a\nb\n", "a\r\nb\r\n"),
            change(LineEnding::Lf, LineEnding::CrLf, true)
        );
        assert_eq!(
            line_ending_change("a\r\nb\r\n", "a\nb\n"),
            change(LineEnding::CrLf, LineEnding::Lf, true)
        );
        assert_eq!(
            line_ending_change("a\nb\n", "a\r\nc\r\n"),
            change(LineEnding::Lf, LineEnding::CrLf, false)
        );
    }

    #[test]
    fn is_none_when_the_style_is_unchanged_or_a_side_has_no_line_breaks() {
        assert_eq!(line_ending_change("a\nb\n", "a\nc\n"), None);
        assert_eq!(line_ending_change("a\r\nb\r\n", "a\r\nc\r\n"), None);
        assert_eq!(line_ending_change("", "a\r\n"), None);
    }
}
