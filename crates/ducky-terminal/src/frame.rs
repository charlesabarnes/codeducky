//! A plain-data copy of what to draw, built from libghostty's render state. Only rows libghostty
//! reports dirty are rebuilt; clean rows are shared with the previous frame.

use std::rc::Rc;

use libghostty_vt::render::{CellIterator, CursorVisualStyle, Dirty, RenderState, RowIterator};
use libghostty_vt::screen::CellWide;
use libghostty_vt::style::{StyleColor, Underline};

use crate::boxdraw;
use crate::color::Rgb;
use crate::emulator::Emulator;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Frame {
    pub cols: u16,
    pub rows: Vec<Rc<RowFrame>>,
    pub background: Rgb,
    pub foreground: Rgb,
    pub cursor: Option<CursorFrame>,
    pub scrollbar: Option<ScrollbarFrame>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct RowFrame {
    pub backgrounds: Vec<BackgroundSpan>,
    pub runs: Vec<TextRunFrame>,
    /// Box-drawing and block characters, drawn as shapes so neighbouring cells join.
    pub shapes: Vec<ShapeCell>,
    /// Inclusive column range.
    pub selection: Option<(u16, u16)>,
    /// The row's text, one entry per column (empty for the tail of a wide character).
    pub cells: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BackgroundSpan {
    pub col: u16,
    pub len: u16,
    pub color: Rgb,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TextRunFrame {
    pub col: u16,
    /// Cells per character: 1, or 2 for wide characters.
    pub cell_width: u16,
    pub text: String,
    pub style: TextStyle,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextStyle {
    pub fg: Rgb,
    pub bold: bool,
    pub italic: bool,
    pub underline: Underline,
    pub underline_color: Option<Rgb>,
    pub strikethrough: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShapeCell {
    pub col: u16,
    pub ch: char,
    pub color: Rgb,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorShape {
    Block,
    HollowBlock,
    Bar,
    Underline,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CursorFrame {
    pub col: u16,
    pub row: u16,
    pub shape: CursorShape,
    pub blinking: bool,
    pub color: Rgb,
    /// The character under the cursor, redrawn in the background colour over a block cursor.
    pub text: Option<String>,
    pub wide: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScrollbarFrame {
    pub total: u64,
    pub offset: u64,
    pub len: u64,
}

impl RowFrame {
    pub fn text(&self) -> String {
        self.cells.concat()
    }
}

impl Frame {
    /// The visible text, one line per row, trailing spaces trimmed.
    pub fn text(&self) -> String {
        let mut out = String::new();
        for row in &self.rows {
            out.push_str(row.text().trim_end());
            out.push('\n');
        }
        out
    }
}

pub struct FrameBuilder {
    state: RenderState<'static>,
    rows: RowIterator<'static>,
    cells: CellIterator<'static>,
    frame: Rc<Frame>,
    force_full: bool,
    rebuilt_rows: usize,
}

impl FrameBuilder {
    pub fn new() -> Result<Self, libghostty_vt::Error> {
        Ok(Self {
            state: RenderState::new()?,
            rows: RowIterator::new()?,
            cells: CellIterator::new()?,
            frame: Rc::default(),
            force_full: true,
            rebuilt_rows: 0,
        })
    }

    /// Rebuild every row on the next update (new emulator, selection or theme change).
    pub fn invalidate(&mut self) {
        self.force_full = true;
    }

    /// Rows rebuilt by the last update.
    #[cfg(test)]
    pub fn rebuilt_rows(&self) -> usize {
        self.rebuilt_rows
    }

    pub fn update(&mut self, terminal: &Emulator) -> Rc<Frame> {
        self.rebuilt_rows = 0;
        let Ok(snapshot) = self.state.update(terminal) else {
            return self.frame.clone();
        };
        let Ok(colors) = snapshot.colors() else {
            return self.frame.clone();
        };
        let dirty = snapshot.dirty().unwrap_or(Dirty::Full);
        let cols = snapshot.cols().unwrap_or(0);
        let row_count = usize::from(snapshot.rows().unwrap_or(0));
        let full = self.force_full
            || dirty == Dirty::Full
            || self.frame.rows.len() != row_count
            || self.frame.cols != cols
            || Rgb::from(colors.background) != self.frame.background
            || Rgb::from(colors.foreground) != self.frame.foreground;

        let mut frame = Frame {
            cols,
            rows: Vec::with_capacity(row_count),
            background: colors.background.into(),
            foreground: colors.foreground.into(),
            cursor: None,
            scrollbar: terminal.scrollbar().ok().map(|s| ScrollbarFrame {
                total: s.total,
                offset: s.offset,
                len: s.len,
            }),
        };
        let resolve = |c: StyleColor| match c {
            StyleColor::None => None,
            StyleColor::Palette(i) => Some(Rgb::from(colors.palette[usize::from(i.0)])),
            StyleColor::Rgb(c) => Some(Rgb::from(c)),
        };

        if dirty != Dirty::Clean || full {
            if let Ok(mut rows) = self.rows.update(&snapshot) {
                let mut y = 0usize;
                while let Some(row) = rows.next() {
                    let reuse = !full && !row.dirty().unwrap_or(true);
                    let cached = self.frame.rows.get(y).filter(|_| reuse).cloned();
                    let built = match cached {
                        Some(row) => row,
                        None => {
                            self.rebuilt_rows += 1;
                            let mut out = RowFrame {
                                selection: row
                                    .selection()
                                    .ok()
                                    .flatten()
                                    .map(|s| (s.start_x, s.end_x)),
                                ..RowFrame::default()
                            };
                            if let Ok(mut cells) = self.cells.update(row) {
                                let mut builder = RowBuilder::new(&mut out, &frame, cols);
                                let mut col: u16 = 0;
                                while let Some(cell) = cells.next() {
                                    let wide = cell
                                        .raw_cell()
                                        .and_then(|c| c.wide())
                                        .unwrap_or(CellWide::Narrow);
                                    let style = cell.style().unwrap_or_default();
                                    let mut text = String::new();
                                    if cell.graphemes_len().unwrap_or(0) > 0 {
                                        let _ = cell.graphemes_utf8(&mut text);
                                    }
                                    builder.push(Cell {
                                        col,
                                        wide,
                                        text,
                                        fg: cell.fg_color().ok().flatten().map(Rgb::from),
                                        bg: cell.bg_color().ok().flatten().map(Rgb::from),
                                        bold: style.bold,
                                        italic: style.italic,
                                        faint: style.faint,
                                        inverse: style.inverse,
                                        invisible: style.invisible,
                                        underline: style.underline,
                                        underline_color: resolve(style.underline_color),
                                        strikethrough: style.strikethrough,
                                    });
                                    col += 1;
                                }
                            }
                            Rc::new(out)
                        }
                    };
                    let _ = row.set_dirty(false);
                    frame.rows.push(built);
                    y += 1;
                }
            }
            let _ = snapshot.set_dirty(Dirty::Clean);
        } else {
            frame.rows = self.frame.rows.clone();
        }

        if let Ok(cursor) = snapshot.cursor()
            && cursor.visible
            && let Some(vp) = cursor.viewport
        {
            let col = if vp.at_wide_tail {
                vp.x.saturating_sub(1)
            } else {
                vp.x
            };
            let row = frame.rows.get(usize::from(vp.y));
            let text = row
                .and_then(|r| r.cells.get(usize::from(col)))
                .filter(|t| !t.trim().is_empty())
                .cloned();
            let wide = row
                .and_then(|r| r.cells.get(usize::from(col) + 1))
                .is_some_and(String::is_empty);
            frame.cursor = Some(CursorFrame {
                col,
                row: vp.y,
                shape: match cursor.visual_style {
                    CursorVisualStyle::Bar => CursorShape::Bar,
                    CursorVisualStyle::Underline => CursorShape::Underline,
                    CursorVisualStyle::BlockHollow => CursorShape::HollowBlock,
                    _ => CursorShape::Block,
                },
                blinking: cursor.blinking,
                color: colors
                    .cursor
                    .map(Rgb::from)
                    .unwrap_or(colors.foreground.into()),
                text,
                wide,
            });
        }
        self.force_full = false;
        self.frame = Rc::new(frame);
        self.frame.clone()
    }
}

struct Cell {
    col: u16,
    wide: CellWide,
    text: String,
    fg: Option<Rgb>,
    bg: Option<Rgb>,
    bold: bool,
    italic: bool,
    faint: bool,
    inverse: bool,
    invisible: bool,
    underline: Underline,
    underline_color: Option<Rgb>,
    strikethrough: bool,
}

struct RowBuilder<'a> {
    row: &'a mut RowFrame,
    background: Rgb,
    foreground: Rgb,
}

impl<'a> RowBuilder<'a> {
    fn new(row: &'a mut RowFrame, frame: &Frame, cols: u16) -> Self {
        row.cells.reserve(usize::from(cols));
        Self {
            row,
            background: frame.background,
            foreground: frame.foreground,
        }
    }

    fn push(&mut self, cell: Cell) {
        if matches!(cell.wide, CellWide::SpacerTail | CellWide::SpacerHead) {
            self.row.cells.push(String::new());
            return;
        }
        let width: u16 = if cell.wide == CellWide::Wide { 2 } else { 1 };
        let mut fg = cell.fg.unwrap_or(self.foreground);
        let mut bg = cell.bg;
        if cell.inverse {
            let old_fg = fg;
            fg = bg.unwrap_or(self.background);
            bg = Some(old_fg);
        }
        if cell.faint {
            fg = fg.mix(bg.unwrap_or(self.background), 0.45);
        }
        if let Some(color) = bg.filter(|c| *c != self.background || cell.inverse) {
            match self.row.backgrounds.last_mut() {
                Some(span) if span.color == color && span.col + span.len == cell.col => {
                    span.len += width
                }
                _ => self.row.backgrounds.push(BackgroundSpan {
                    col: cell.col,
                    len: width,
                    color,
                }),
            }
        }
        let shown = if cell.text.is_empty() {
            " ".to_owned()
        } else {
            cell.text.clone()
        };
        self.row.cells.push(shown);
        if cell.text.is_empty() || cell.invisible {
            return;
        }
        let mut chars = cell.text.chars();
        let first = chars.next().unwrap_or(' ');
        let single = chars.next().is_none();
        if single && boxdraw::is_procedural(first) {
            self.row.shapes.push(ShapeCell {
                col: cell.col,
                ch: first,
                color: fg,
            });
            return;
        }
        if first == ' ' && single && cell.underline == Underline::None && !cell.strikethrough {
            return;
        }
        let style = TextStyle {
            fg,
            bold: cell.bold,
            italic: cell.italic,
            underline: cell.underline,
            underline_color: cell.underline_color,
            strikethrough: cell.strikethrough,
        };
        if single
            && width == 1
            && let Some(run) = self.row.runs.last_mut()
            && run.cell_width == 1
            && run.style == style
            && run.col + run.text.chars().count() as u16 == cell.col
        {
            run.text.push(first);
            return;
        }
        self.row.runs.push(TextRunFrame {
            col: cell.col,
            cell_width: width,
            text: cell.text,
            style,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::emulator::new_emulator;
    use crate::source::GridSize;
    use crate::theme::TerminalColors;

    fn terminal(cols: u16, rows: u16) -> Emulator {
        let size = GridSize {
            cols,
            rows,
            cell_width: 8,
            cell_height: 16,
        };
        new_emulator(size, &TerminalColors::default(), 100)
            .unwrap()
            .0
    }

    fn build(bytes: &[u8]) -> Rc<Frame> {
        let mut t = terminal(20, 4);
        t.vt_write(bytes);
        FrameBuilder::new().unwrap().update(&t)
    }

    #[test]
    fn plain_text_becomes_one_run_per_style() {
        let frame = build(b"ab\x1b[1mcd\x1b[0m e");
        let row = &frame.rows[0];
        let runs: Vec<_> = row
            .runs
            .iter()
            .map(|r| (r.col, r.text.as_str(), r.style.bold))
            .collect();
        assert_eq!(
            runs,
            vec![(0, "ab", false), (2, "cd", true), (5, "e", false)]
        );
        assert_eq!(frame.text().lines().next(), Some("abcd e"));
    }

    #[test]
    fn colours_resolve_through_palette_and_truecolor() {
        let colors = TerminalColors::default();
        let frame = build(b"\x1b[31mr\x1b[38;5;130mx\x1b[38;2;1;2;3mt\x1b[44m \x1b[0m");
        let row = &frame.rows[0];
        assert_eq!(row.runs[0].style.fg, colors.ansi[1]);
        assert_eq!(row.runs[0].text, "r");
        assert_ne!(row.runs[1].style.fg, colors.ansi[1]);
        assert_eq!(row.runs[2].style.fg, Rgb::new(1, 2, 3));
        assert_eq!(row.backgrounds[0].col, 3);
        assert_eq!(row.backgrounds[0].color, colors.ansi[4]);
    }

    #[test]
    fn inverse_swaps_and_faint_dims() {
        let colors = TerminalColors::default();
        let frame = build(b"\x1b[7mi\x1b[0m\x1b[2mf");
        let row = &frame.rows[0];
        assert_eq!(row.backgrounds[0].color, colors.foreground);
        assert_eq!(row.runs[0].style.fg, colors.background);
        assert_ne!(row.runs[1].style.fg, colors.foreground);
    }

    #[test]
    fn styles_and_decorations_are_kept() {
        let frame = build(b"\x1b[3mi\x1b[0m\x1b[4:3mc\x1b[0m\x1b[9ms\x1b[0m\x1b[58;2;9;9;9;4mu");
        let row = &frame.rows[0];
        assert!(row.runs[0].style.italic);
        assert_eq!(row.runs[1].style.underline, Underline::Curly);
        assert!(row.runs[2].style.strikethrough);
        assert_eq!(row.runs[3].style.underline_color, Some(Rgb::new(9, 9, 9)));
    }

    #[test]
    fn wide_characters_take_two_cells() {
        let frame = build("a日b🦆".as_bytes());
        let row = &frame.rows[0];
        let runs: Vec<_> = row
            .runs
            .iter()
            .map(|r| (r.col, r.cell_width, r.text.as_str()))
            .collect();
        assert_eq!(
            runs,
            vec![(0, 1, "a"), (1, 2, "日"), (3, 1, "b"), (4, 2, "🦆")]
        );
        assert_eq!(row.cells[2], "");
        assert_eq!(row.text(), format!("a日b🦆{}", " ".repeat(14)));
    }

    #[test]
    fn box_drawing_becomes_shapes() {
        let frame = build("╭─╮x".as_bytes());
        let row = &frame.rows[0];
        let shapes: Vec<_> = row.shapes.iter().map(|s| (s.col, s.ch)).collect();
        assert_eq!(shapes, vec![(0, '╭'), (1, '─'), (2, '╮')]);
        assert_eq!(row.runs.len(), 1);
    }

    #[test]
    fn only_dirty_rows_are_rebuilt() {
        let mut t = terminal(20, 4);
        let mut builder = FrameBuilder::new().unwrap();
        t.vt_write(b"one\r\ntwo\r\nthree");
        let first = builder.update(&t);
        assert_eq!(builder.rebuilt_rows(), 4);
        t.vt_write(b"\x1b[1;1Hx");
        let second = builder.update(&t);
        assert!(builder.rebuilt_rows() < 4, "{}", builder.rebuilt_rows());
        assert!(Rc::ptr_eq(&first.rows[1], &second.rows[1]));
        assert_eq!(second.text().lines().next(), Some("xne"));
        let third = builder.update(&t);
        assert_eq!(builder.rebuilt_rows(), 0);
        assert!(Rc::ptr_eq(&second.rows[0], &third.rows[0]));
    }

    #[test]
    fn cursor_shape_and_position() {
        let frame = build(b"ab\x1b[5 q");
        let cursor = frame.cursor.as_ref().unwrap();
        assert_eq!((cursor.col, cursor.row), (2, 0));
        assert_eq!(cursor.shape, CursorShape::Bar);
        assert!(cursor.blinking);
        let frame = build(b"ab\x1b[1D");
        assert_eq!(frame.cursor.as_ref().unwrap().text.as_deref(), Some("b"));
        let frame = build(b"\x1b[?25l");
        assert!(frame.cursor.is_none());
    }
}
