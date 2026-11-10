//! Terminals: the hc attach stream fed through libghostty-vt, drawn by GPUI.

use libghostty_vt::Terminal;

/// Cursor position (column, row) after feeding `bytes` to a fresh `cols` x `rows` terminal.
pub fn cursor_after(
    cols: u16,
    rows: u16,
    bytes: &[u8],
) -> Result<(u16, u16), libghostty_vt::Error> {
    let mut terminal = Terminal::new(cols, rows)?;
    terminal.vt_write(bytes);
    Ok((terminal.cursor_x()?, terminal.cursor_y()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feeds_bytes_through_libghostty_vt() {
        assert_eq!(cursor_after(80, 24, b"hello\r\nab").unwrap(), (2, 1));
        assert_eq!(cursor_after(80, 24, b"\x1b[5;10H").unwrap(), (9, 4));
    }
}
