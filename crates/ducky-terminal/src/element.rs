//! Painting a [`Frame`] with GPUI: backgrounds, selection, text runs, procedural box glyphs,
//! cursor, IME preedit, link underline and scrollbar.

use std::rc::Rc;

use gpui_kit::{
    App, Bounds, Font, FontFeatures, FontStyle, FontWeight, Hsla, PathBuilder, Pixels, Point,
    SharedString, Size, StrikethroughStyle, TextAlign, TextRun, UnderlineStyle, Window, fill,
    outline, point, px, size,
};
use libghostty_vt::style::Underline;

use crate::boxdraw::{self, PathOp, Prim};
use crate::color::Rgb;
use crate::frame::{CursorFrame, CursorShape, Frame, TextStyle};
use crate::links::Link;
use crate::theme::TerminalColors;

#[derive(Clone, Debug, PartialEq)]
pub struct Metrics {
    pub font: Font,
    pub font_size: Pixels,
    pub cell: Size<Pixels>,
    pub padding: Pixels,
}

impl Metrics {
    pub fn measure(
        family: SharedString,
        font_size: f32,
        line_height: f32,
        padding: f32,
        window: &Window,
    ) -> Self {
        let font = Font {
            family,
            features: FontFeatures::disable_ligatures(),
            fallbacks: None,
            weight: FontWeight::NORMAL,
            style: FontStyle::Normal,
        };
        let font_size = px(font_size);
        let text = window.text_system();
        let id = text.resolve_font(&font);
        let width = text
            .advance(id, font_size, 'm')
            .map(|s| s.width)
            .unwrap_or(font_size * 0.6);
        Self {
            font,
            font_size,
            cell: size(width, (font_size * line_height).round()),
            padding: px(padding),
        }
    }

    /// Top-left of the grid, on a whole pixel so rows of block glyphs meet without seams.
    pub fn grid_origin(&self, bounds: Bounds<Pixels>) -> Point<Pixels> {
        point(
            (bounds.origin.x + self.padding).round(),
            (bounds.origin.y + self.padding).round(),
        )
    }

    pub fn cell_bounds(
        &self,
        origin: Point<Pixels>,
        col: u16,
        row: u16,
        width: u16,
    ) -> Bounds<Pixels> {
        Bounds::new(
            origin
                + point(
                    self.cell.width * f32::from(col),
                    self.cell.height * f32::from(row),
                ),
            size(self.cell.width * f32::from(width), self.cell.height),
        )
    }
}

pub struct PaintInput {
    pub frame: Rc<Frame>,
    pub metrics: Metrics,
    pub colors: TerminalColors,
    pub focused: bool,
    pub cursor_visible: bool,
    pub link: Option<Link>,
    pub preedit: Option<String>,
    /// The emulator's grid when another viewer set a size different from ours.
    pub letterbox: Option<(u16, u16)>,
}

pub fn paint(input: &PaintInput, bounds: Bounds<Pixels>, window: &mut Window, cx: &mut App) {
    let frame = &*input.frame;
    let m = &input.metrics;
    let origin = m.grid_origin(bounds);
    let bg = frame.background.hsla();
    match input.letterbox {
        Some((cols, rows)) => {
            window.paint_quad(fill(bounds, input.colors.letterbox.hsla()));
            let grid = Bounds::new(
                origin,
                size(
                    m.cell.width * f32::from(cols),
                    m.cell.height * f32::from(rows),
                ),
            );
            window.paint_quad(fill(grid, bg));
        }
        None => window.paint_quad(fill(bounds, bg)),
    }
    let scale = window.scale_factor();
    let snap = |v: Pixels| px((f32::from(v) * scale).round() / scale);
    let selection = input.colors.selection_background.hsla();

    window.with_content_mask(Some(gpui_kit::ContentMask { bounds }), |window| {
        for (y, row) in frame.rows.iter().enumerate() {
            let y = y as u16;
            for span in &row.backgrounds {
                window.paint_quad(fill(
                    snap_bounds(m.cell_bounds(origin, span.col, y, span.len), snap),
                    span.color.hsla(),
                ));
            }
            if let Some((start, end)) = row.selection {
                let len = end.saturating_sub(start) + 1;
                window.paint_quad(fill(
                    snap_bounds(m.cell_bounds(origin, start, y, len), snap),
                    selection,
                ));
            }
        }

        let cursor = input
            .cursor_visible
            .then_some(frame.cursor.as_ref())
            .flatten();
        let solid_cursor = cursor.filter(|c| input.focused && c.shape == CursorShape::Block);
        if let Some(c) = solid_cursor {
            let width = if c.wide { 2 } else { 1 };
            window.paint_quad(fill(
                m.cell_bounds(origin, c.col, c.row, width),
                c.color.hsla(),
            ));
        }

        for (y, row) in frame.rows.iter().enumerate() {
            let y = y as u16;
            for run in &row.runs {
                let at = m.cell_bounds(origin, run.col, y, 1).origin;
                paint_text(&run.text, at, run.cell_width, &run.style, m, window, cx);
            }
            let light = (f32::from(m.cell.width) / 8.0).round().max(1.0);
            for shape in &row.shapes {
                let cell = m.cell_bounds(origin, shape.col, y, 1);
                paint_shape(shape.ch, cell, light, shape.color, snap, window);
            }
        }

        if let Some(c) = cursor {
            paint_cursor(
                c,
                input.focused,
                solid_cursor.is_some(),
                frame.background,
                m,
                origin,
                window,
                cx,
            );
        }

        if let Some(link) = &input.link {
            let cell = m.cell_bounds(origin, link.start, link.row, link.end - link.start + 1);
            let line = Bounds::new(
                point(cell.origin.x, cell.bottom() - px(2.0)),
                size(cell.size.width, px(1.0)),
            );
            window.paint_quad(fill(line, input.colors.link.hsla()));
        }

        if let (Some(text), Some(c)) = (&input.preedit, frame.cursor.as_ref()) {
            paint_preedit(text, c, frame, m, origin, window, cx);
        }

        if let Some(bar) = frame.scrollbar.filter(|b| b.total > b.len) {
            let track = scrollbar_track(bounds);
            let h = f32::from(track.size.height);
            let thumb_h = (h * bar.len as f32 / bar.total as f32).max(16.0);
            let top = (h - thumb_h) * bar.offset as f32 / (bar.total - bar.len) as f32;
            let thumb = Bounds::new(
                track.origin + point(px(0.0), px(top)),
                size(track.size.width, px(thumb_h)),
            );
            let alpha = if bar.offset + bar.len >= bar.total {
                0.35
            } else {
                0.8
            };
            let quad = fill(thumb, input.colors.scrollbar_thumb.hsla().opacity(alpha))
                .corner_radii(px(3.0));
            window.paint_quad(quad);
        }
    });
}

/// Where the scrollbar thumb runs, along the right edge.
pub fn scrollbar_track(bounds: Bounds<Pixels>) -> Bounds<Pixels> {
    Bounds::new(
        point(bounds.right() - px(8.0), bounds.origin.y + px(2.0)),
        size(px(6.0), bounds.size.height - px(4.0)),
    )
}

fn snap_bounds(b: Bounds<Pixels>, snap: impl Fn(Pixels) -> Pixels) -> Bounds<Pixels> {
    let (x0, y0) = (snap(b.origin.x), snap(b.origin.y));
    let (x1, y1) = (snap(b.right()), snap(b.bottom()));
    Bounds::new(point(x0, y0), size(x1 - x0, y1 - y0))
}

fn run_font(base: &Font, bold: bool, italic: bool) -> Font {
    let mut font = base.clone();
    if bold {
        font.weight = FontWeight::BOLD;
    }
    if italic {
        font.style = FontStyle::Italic;
    }
    font
}

fn paint_text(
    text: &str,
    origin: Point<Pixels>,
    cell_width: u16,
    style: &TextStyle,
    m: &Metrics,
    window: &mut Window,
    cx: &mut App,
) {
    paint_text_colored(
        text,
        origin,
        cell_width,
        style,
        style.fg.hsla(),
        m,
        window,
        cx,
    );
}

#[allow(clippy::too_many_arguments)]
fn paint_text_colored(
    text: &str,
    origin: Point<Pixels>,
    cell_width: u16,
    style: &TextStyle,
    color: Hsla,
    m: &Metrics,
    window: &mut Window,
    cx: &mut App,
) {
    let decoration = style.underline_color.map(Rgb::hsla).unwrap_or(color);
    let run = TextRun {
        len: text.len(),
        font: run_font(&m.font, style.bold, style.italic),
        color,
        background_color: None,
        underline: (style.underline != Underline::None).then_some(UnderlineStyle {
            thickness: px(1.0),
            color: Some(decoration),
            wavy: style.underline == Underline::Curly,
        }),
        strikethrough: style.strikethrough.then_some(StrikethroughStyle {
            thickness: px(1.0),
            color: Some(color),
        }),
    };
    let line = window.text_system().shape_line(
        SharedString::from(text.to_owned()),
        m.font_size,
        &[run],
        Some(m.cell.width * f32::from(cell_width)),
    );
    let _ = line.paint(origin, m.cell.height, TextAlign::Left, None, window, cx);
}

fn paint_shape(
    ch: char,
    cell: Bounds<Pixels>,
    light: f32,
    color: Rgb,
    snap: impl Fn(Pixels) -> Pixels,
    window: &mut Window,
) {
    let (w, h) = (f32::from(cell.size.width), f32::from(cell.size.height));
    let Some(prims) = boxdraw::shapes(ch, w, h, light) else {
        return;
    };
    let at = |x: f32, y: f32| cell.origin + point(px(x), px(y));
    for prim in prims {
        match prim {
            Prim::Rect {
                x0,
                y0,
                x1,
                y1,
                alpha,
            } => {
                let b = Bounds::from_corners(at(x0, y0), at(x1, y1));
                window.paint_quad(fill(snap_bounds(b, &snap), color.hsla().opacity(alpha)));
            }
            Prim::Stroke { ops, width } => {
                let mut path = PathBuilder::stroke(px(width));
                for op in ops {
                    match op {
                        PathOp::Move(x, y) => path.move_to(at(x, y)),
                        PathOp::Line(x, y) => path.line_to(at(x, y)),
                        PathOp::Quad { to, ctrl } => {
                            path.curve_to(at(to.0, to.1), at(ctrl.0, ctrl.1))
                        }
                    }
                }
                if let Ok(path) = path.build() {
                    window.paint_path(path, color.hsla());
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn paint_cursor(
    c: &CursorFrame,
    focused: bool,
    solid: bool,
    background: Rgb,
    m: &Metrics,
    origin: Point<Pixels>,
    window: &mut Window,
    cx: &mut App,
) {
    let width = if c.wide { 2 } else { 1 };
    let cell = m.cell_bounds(origin, c.col, c.row, width);
    let color = c.color.hsla();
    if solid {
        if let Some(text) = &c.text {
            let style = TextStyle {
                fg: background,
                bold: false,
                italic: false,
                underline: Underline::None,
                underline_color: None,
                strikethrough: false,
            };
            paint_text_colored(
                text,
                cell.origin,
                width,
                &style,
                background.hsla(),
                m,
                window,
                cx,
            );
        }
        return;
    }
    let shape = if focused {
        c.shape
    } else {
        CursorShape::HollowBlock
    };
    match shape {
        CursorShape::Bar => {
            window.paint_quad(fill(
                Bounds::new(cell.origin, size(px(2.0), cell.size.height)),
                color,
            ));
        }
        CursorShape::Underline => {
            let line = Bounds::new(
                point(cell.origin.x, cell.bottom() - px(2.0)),
                size(cell.size.width, px(2.0)),
            );
            window.paint_quad(fill(line, color));
        }
        CursorShape::Block | CursorShape::HollowBlock => {
            window.paint_quad(outline(cell, color, gpui_kit::BorderStyle::Solid));
        }
    }
}

fn paint_preedit(
    text: &str,
    c: &CursorFrame,
    frame: &Frame,
    m: &Metrics,
    origin: Point<Pixels>,
    window: &mut Window,
    cx: &mut App,
) {
    let cells: u16 = text
        .chars()
        .map(|ch| if is_wide(ch) { 2 } else { 1 })
        .sum::<u16>()
        .max(1);
    let area = m.cell_bounds(origin, c.col, c.row, cells);
    window.paint_quad(fill(area, frame.background.hsla()));
    let style = TextStyle {
        fg: frame.foreground,
        bold: false,
        italic: false,
        underline: Underline::Single,
        underline_color: None,
        strikethrough: false,
    };
    let mut x = area.origin.x;
    for ch in text.chars() {
        let w = if is_wide(ch) { 2 } else { 1 };
        paint_text(
            &ch.to_string(),
            point(x, area.origin.y),
            w,
            &style,
            m,
            window,
            cx,
        );
        x += m.cell.width * f32::from(w);
    }
}

/// East Asian wide ranges, enough to lay out IME preedit before the program echoes the text.
fn is_wide(ch: char) -> bool {
    matches!(ch as u32,
        0x1100..=0x115F | 0x2E80..=0x303E | 0x3041..=0x33FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF
        | 0xA000..=0xA4CF | 0xAC00..=0xD7A3 | 0xF900..=0xFAFF | 0xFE30..=0xFE4F | 0xFF00..=0xFF60
        | 0xFFE0..=0xFFE6 | 0x1F300..=0x1F64F | 0x1F900..=0x1F9FF | 0x20000..=0x3FFFD)
}
