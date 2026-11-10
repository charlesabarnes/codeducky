//! Links under the pointer: OSC 8 hyperlinks, else URLs found in the row's text.

use libghostty_vt::terminal::{Point, PointCoordinate};

use crate::emulator::Emulator;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Link {
    pub row: u16,
    /// Inclusive column range.
    pub start: u16,
    pub end: u16,
    pub url: String,
}

const SCHEMES: &[&str] = &[
    "https://", "http://", "file://", "ssh://", "git://", "ftp://", "mailto:",
];

/// The URL covering `col` in a row given one string per column (empty for wide-char tails).
pub fn url_at(cells: &[String], row: u16, col: u16) -> Option<Link> {
    let mut text = String::new();
    let mut col_of_byte = Vec::new();
    for (c, cell) in cells.iter().enumerate() {
        for _ in 0..cell.len() {
            col_of_byte.push(c as u16);
        }
        text.push_str(cell);
    }
    let mut search = 0;
    while search < text.len() {
        let (start, scheme) = SCHEMES
            .iter()
            .filter_map(|s| text[search..].find(s).map(|i| (search + i, *s)))
            .min_by_key(|(i, _)| *i)?;
        let end = url_end(&text, start, scheme.len());
        if end > start + scheme.len() {
            let (first, last) = (col_of_byte[start], col_of_byte[end - 1]);
            if (first..=last).contains(&col) {
                return Some(Link {
                    row,
                    start: first,
                    end: last,
                    url: text[start..end].to_owned(),
                });
            }
        }
        search = end.max(start + 1);
    }
    None
}

fn url_end(text: &str, start: usize, scheme_len: usize) -> usize {
    let body = &text[start + scheme_len..];
    let mut end = start + scheme_len;
    for (i, ch) in body.char_indices() {
        if ch.is_whitespace() || ch.is_control() || "<>\"`{}|\\^".contains(ch) {
            break;
        }
        end = start + scheme_len + i + ch.len_utf8();
    }
    loop {
        let url = &text[start..end];
        let Some(last) = url.chars().last() else {
            return end;
        };
        let unbalanced =
            |open, close| last == close && url.matches(open).count() < url.matches(close).count();
        if ".,;:!?'".contains(last) || unbalanced('(', ')') || unbalanced('[', ']') {
            end -= last.len_utf8();
        } else {
            return end;
        }
    }
}

/// The OSC 8 hyperlink at a viewport cell, if the program set one.
pub fn hyperlink_at(terminal: &Emulator, col: u16, row: u16) -> Option<String> {
    let grid_ref = terminal
        .grid_ref(Point::Viewport(PointCoordinate {
            x: col,
            y: u32::from(row),
        }))
        .ok()?;
    let mut buf = vec![0u8; 2048];
    let len = match grid_ref.hyperlink_uri(&mut buf) {
        Ok(len) => len,
        Err(libghostty_vt::Error::OutOfSpace { required }) => {
            buf.resize(required, 0);
            grid_ref.hyperlink_uri(&mut buf).ok()?
        }
        Err(_) => return None,
    };
    (len > 0).then(|| String::from_utf8_lossy(&buf[..len]).into_owned())
}

/// The extent of the OSC 8 link at `col`: neighbouring cells with the same URI.
pub fn hyperlink_span(terminal: &Emulator, col: u16, row: u16) -> Option<Link> {
    let url = hyperlink_at(terminal, col, row)?;
    let cols = terminal.cols().ok()?;
    let same = |c: u16| hyperlink_at(terminal, c, row).as_deref() == Some(url.as_str());
    let mut start = col;
    while start > 0 && same(start - 1) {
        start -= 1;
    }
    let mut end = col;
    while end + 1 < cols && same(end + 1) {
        end += 1;
    }
    Some(Link {
        row,
        start,
        end,
        url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::emulator::new_emulator;
    use crate::source::GridSize;
    use crate::theme::TerminalColors;

    fn cells(s: &str) -> Vec<String> {
        s.chars().map(String::from).collect()
    }

    #[test]
    fn finds_the_url_under_the_column() {
        let row = cells("see https://example.com/a?b=1. and more");
        let link = url_at(&row, 0, 6).unwrap();
        assert_eq!(link.url, "https://example.com/a?b=1");
        assert_eq!((link.start, link.end), (4, 28));
        assert_eq!(url_at(&row, 0, 2), None);
        assert_eq!(url_at(&row, 0, 29), None);
    }

    #[test]
    fn trims_unbalanced_brackets_but_keeps_balanced_ones() {
        let row = cells("(https://en.wikipedia.org/wiki/Rust_(language))");
        assert_eq!(
            url_at(&row, 0, 5).unwrap().url,
            "https://en.wikipedia.org/wiki/Rust_(language)"
        );
    }

    #[test]
    fn maps_columns_across_wide_characters() {
        let mut row = cells("日");
        row.push(String::new());
        row.extend(cells(" http://x.io"));
        let link = url_at(&row, 3, 5).unwrap();
        assert_eq!((link.row, link.start, link.end), (3, 3, 13));
    }

    #[test]
    fn osc8_hyperlinks() {
        let size = GridSize {
            cols: 20,
            rows: 2,
            cell_width: 8,
            cell_height: 16,
        };
        let mut t = new_emulator(size, &TerminalColors::default(), 10)
            .unwrap()
            .0;
        t.vt_write(b"ab \x1b]8;;https://ghostty.org\x1b\\link\x1b]8;;\x1b\\ c");
        assert_eq!(hyperlink_at(&t, 0, 0), None);
        let link = hyperlink_span(&t, 4, 0).unwrap();
        assert_eq!(link.url, "https://ghostty.org");
        assert_eq!((link.start, link.end), (3, 6));
    }
}
