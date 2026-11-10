//! Mouse selection through libghostty's gesture state machine (click, double-click word,
//! triple-click line, drag), and the selected text through its plain-text formatter.

use std::time::{Duration, Instant};

use libghostty_vt::fmt::{Format, Formatter};
use libghostty_vt::selection::gesture::{
    DragEvent, Geometry as GestureGeometry, Gesture, PressEvent, ReleaseEvent,
};
use libghostty_vt::terminal::{Point, PointCoordinate};

use crate::emulator::Emulator;
use crate::input::mouse::Geometry;

const REPEAT_INTERVAL: Duration = Duration::from_millis(500);

pub struct Selector {
    gesture: Gesture<'static>,
    press: PressEvent<'static>,
    drag: DragEvent<'static>,
    release: ReleaseEvent<'static>,
    epoch: Instant,
    active: bool,
}

impl Selector {
    pub fn new() -> Result<Self, libghostty_vt::Error> {
        let mut press = PressEvent::new()?;
        press.set_repeat_interval(REPEAT_INTERVAL)?;
        Ok(Self {
            gesture: Gesture::new()?,
            press,
            drag: DragEvent::new()?,
            release: ReleaseEvent::new()?,
            epoch: Instant::now(),
            active: false,
        })
    }

    /// A drag that started with a press here is in progress.
    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn press(&mut self, terminal: &Emulator, geometry: Geometry, pos: (f32, f32), at: Instant) {
        let Some(grid_ref) = viewport_ref(terminal, geometry, pos) else {
            return;
        };
        let elapsed = at.saturating_duration_since(self.epoch);
        let Ok(press) = self
            .press
            .set_repeat_distance(f64::from(geometry.cell_width))
            .and_then(|p| p.set_time(elapsed))
            .and_then(|p| p.set_position(f64::from(pos.0), f64::from(pos.1)))
        else {
            return;
        };
        if let Ok(selection) = press.apply(&mut self.gesture, terminal, grid_ref) {
            let _ = terminal.set_selection(selection.as_ref());
            self.active = true;
        }
    }

    pub fn drag(
        &mut self,
        terminal: &Emulator,
        geometry: Geometry,
        pos: (f32, f32),
        rectangle: bool,
    ) {
        if !self.active {
            return;
        }
        let Some(grid_ref) = viewport_ref(terminal, geometry, pos) else {
            return;
        };
        let Ok(cols) = terminal.cols() else { return };
        let gesture_geometry = GestureGeometry {
            columns: u32::from(cols),
            cell_width: geometry.cell_width.round().max(1.0) as u32,
            padding_left: geometry.padding.round() as u32,
            screen_height: geometry.height.round().max(1.0) as u32,
        };
        let Ok(drag) = self
            .drag
            .set_rectangle(rectangle)
            .and_then(|d| d.set_position(f64::from(pos.0), f64::from(pos.1)))
        else {
            return;
        };
        if let Ok(selection) = drag.apply(&mut self.gesture, terminal, grid_ref, gesture_geometry) {
            let _ = terminal.set_selection(selection.as_ref());
        }
    }

    pub fn release(&mut self, terminal: &Emulator, geometry: Geometry, pos: (f32, f32)) {
        if !self.active {
            return;
        }
        self.active = false;
        let grid_ref = viewport_ref(terminal, geometry, pos);
        let _ = self.release.apply(&mut self.gesture, terminal, grid_ref);
    }

    pub fn clear(&mut self, terminal: &Emulator) {
        self.active = false;
        let _ = terminal.set_selection(None);
    }
}

fn viewport_ref(
    terminal: &Emulator,
    geometry: Geometry,
    (x, y): (f32, f32),
) -> Option<libghostty_vt::screen::GridRef<'_>> {
    let cols = terminal.cols().ok()?;
    let rows = terminal.rows().ok()?;
    let (col, row) = geometry.cell_at(x, y, cols, rows);
    terminal
        .grid_ref(Point::Viewport(PointCoordinate {
            x: col,
            y: u32::from(row),
        }))
        .ok()
}

pub fn has_selection(terminal: &Emulator) -> bool {
    terminal.selection().ok().flatten().is_some()
}

/// The selection as plain text: soft-wrapped lines joined, trailing spaces trimmed.
pub fn selected_text(terminal: &Emulator) -> Option<String> {
    let mut formatter = Formatter::new_selection(terminal).ok()??;
    formatter
        .set_format(Format::Plain)
        .ok()?
        .set_unwrap(true)
        .ok()?
        .set_trim(true)
        .ok()?;
    let bytes = formatter.format_alloc(None).ok()?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    (!text.is_empty()).then_some(text)
}

pub fn select_all(terminal: &Emulator) {
    if let Ok(selection) = terminal.select_all() {
        let _ = terminal.set_selection(selection.as_ref());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::emulator::new_emulator;
    use crate::source::GridSize;
    use crate::theme::TerminalColors;

    const GEOMETRY: Geometry = Geometry {
        width: 172.0,
        height: 76.0,
        cell_width: 8.0,
        cell_height: 16.0,
        padding: 6.0,
    };

    fn terminal(bytes: &[u8]) -> Emulator {
        let size = GridSize {
            cols: 20,
            rows: 4,
            cell_width: 8,
            cell_height: 16,
        };
        let mut t = new_emulator(size, &TerminalColors::default(), 10)
            .unwrap()
            .0;
        t.vt_write(bytes);
        t
    }

    /// Pixel centre of a cell.
    fn at(col: u16, row: u16) -> (f32, f32) {
        (
            6.0 + 8.0 * f32::from(col) + 4.0,
            6.0 + 16.0 * f32::from(row) + 8.0,
        )
    }

    #[test]
    fn drag_selects_across_lines() {
        let t = terminal(b"hello world\r\nsecond line");
        let mut s = Selector::new().unwrap();
        let now = Instant::now();
        s.press(&t, GEOMETRY, at(6, 0), now);
        let end = (at(5, 1).0 + 3.0, at(5, 1).1);
        s.drag(&t, GEOMETRY, end, false);
        s.release(&t, GEOMETRY, end);
        assert_eq!(selected_text(&t).as_deref(), Some("world\nsecond"));
        s.clear(&t);
        assert_eq!(selected_text(&t), None);
    }

    #[test]
    fn double_click_selects_a_word_and_triple_a_line() {
        let t = terminal(b"hello world foo");
        let mut s = Selector::new().unwrap();
        let now = Instant::now();
        for i in 0..2 {
            s.press(&t, GEOMETRY, at(7, 0), now + Duration::from_millis(50 * i));
            s.release(&t, GEOMETRY, at(7, 0));
        }
        assert_eq!(selected_text(&t).as_deref(), Some("world"));
        s.press(&t, GEOMETRY, at(7, 0), now + Duration::from_millis(100));
        s.release(&t, GEOMETRY, at(7, 0));
        assert_eq!(selected_text(&t).as_deref(), Some("hello world foo"));
    }

    #[test]
    fn soft_wrapped_lines_copy_as_one() {
        let t = terminal(b"0123456789abcdefghijKLMN");
        select_all(&t);
        assert_eq!(
            selected_text(&t).as_deref(),
            Some("0123456789abcdefghijKLMN")
        );
    }
}
