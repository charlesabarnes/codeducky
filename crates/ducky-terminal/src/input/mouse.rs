//! Mouse reports to programs that enabled mouse tracking, through libghostty's mouse encoder.

use libghostty_vt::key::Mods;
use libghostty_vt::mouse::{self, Action, Button, EncoderSize, Position};

use crate::emulator::Emulator;

/// The grid's geometry in pixels relative to the element's origin.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Geometry {
    pub width: f32,
    pub height: f32,
    pub cell_width: f32,
    pub cell_height: f32,
    pub padding: f32,
}

impl Geometry {
    /// The viewport cell under `(x, y)`, clamped into `cols` x `rows`.
    pub fn cell_at(&self, x: f32, y: f32, cols: u16, rows: u16) -> (u16, u16) {
        let col = ((x - self.padding) / self.cell_width).floor();
        let row = ((y - self.padding) / self.cell_height).floor();
        (
            col.clamp(0.0, f32::from(cols.saturating_sub(1))) as u16,
            row.clamp(0.0, f32::from(rows.saturating_sub(1))) as u16,
        )
    }
}

pub struct MouseReporter {
    encoder: mouse::Encoder<'static>,
    event: mouse::Event<'static>,
}

impl MouseReporter {
    pub fn new() -> Result<Self, libghostty_vt::Error> {
        let mut encoder = mouse::Encoder::new()?;
        encoder.set_track_last_cell(true);
        Ok(Self {
            encoder,
            event: mouse::Event::new()?,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn encode(
        &mut self,
        terminal: &Emulator,
        geometry: Geometry,
        action: Action,
        button: Option<Button>,
        (x, y): (f32, f32),
        mods: Mods,
        any_pressed: bool,
    ) -> Vec<u8> {
        let px = |v: f32| v.max(0.0).round() as u32;
        let size = EncoderSize {
            screen_width: px(geometry.width).max(1),
            screen_height: px(geometry.height).max(1),
            cell_width: px(geometry.cell_width).max(1),
            cell_height: px(geometry.cell_height).max(1),
            padding_top: px(geometry.padding),
            padding_bottom: px(geometry.padding),
            padding_left: px(geometry.padding),
            padding_right: px(geometry.padding),
        };
        let mut out = Vec::new();
        self.encoder.set_options_from_terminal(terminal);
        if self.encoder.set_size(size).is_err() {
            return out;
        }
        self.encoder.set_any_button_pressed(any_pressed);
        self.event
            .set_action(action)
            .set_button(button)
            .set_mods(mods)
            .set_position(Position { x, y });
        let _ = self.encoder.encode_to_vec(&self.event, &mut out);
        out
    }

    /// Wheel ticks as button 4/5 presses; wheel buttons have no release report.
    pub fn wheel(
        &mut self,
        terminal: &Emulator,
        geometry: Geometry,
        position: (f32, f32),
        lines: i32,
        mods: Mods,
    ) -> Vec<u8> {
        let button = if lines > 0 {
            Button::Four
        } else {
            Button::Five
        };
        let mut out = Vec::new();
        for _ in 0..lines.unsigned_abs() {
            out.extend(self.encode(
                terminal,
                geometry,
                Action::Press,
                Some(button),
                position,
                mods,
                false,
            ));
        }
        out
    }
}

pub fn mods(m: gpui_kit::Modifiers) -> Mods {
    let mut mods = Mods::empty();
    if m.shift {
        mods |= Mods::SHIFT;
    }
    if m.alt {
        mods |= Mods::ALT;
    }
    if m.control {
        mods |= Mods::CTRL;
    }
    if m.platform {
        mods |= Mods::SUPER;
    }
    mods
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

    fn terminal() -> Emulator {
        let size = GridSize {
            cols: 20,
            rows: 4,
            cell_width: 8,
            cell_height: 16,
        };
        new_emulator(size, &TerminalColors::default(), 10)
            .unwrap()
            .0
    }

    #[test]
    fn nothing_is_reported_without_tracking() {
        let t = terminal();
        let mut m = MouseReporter::new().unwrap();
        let out = m.encode(
            &t,
            GEOMETRY,
            Action::Press,
            Some(Button::Left),
            (30.0, 30.0),
            Mods::empty(),
            true,
        );
        assert!(out.is_empty());
    }

    #[test]
    fn sgr_reports_cells() {
        let mut t = terminal();
        t.vt_write(b"\x1b[?1000h\x1b[?1006h");
        let mut m = MouseReporter::new().unwrap();
        // x 30 -> col 3, y 30 -> row 1 (1-based 4;2).
        let out = m.encode(
            &t,
            GEOMETRY,
            Action::Press,
            Some(Button::Left),
            (30.0, 30.0),
            Mods::empty(),
            true,
        );
        assert_eq!(out, b"\x1b[<0;4;2M");
        let out = m.encode(
            &t,
            GEOMETRY,
            Action::Release,
            Some(Button::Left),
            (30.0, 30.0),
            Mods::empty(),
            false,
        );
        assert_eq!(out, b"\x1b[<0;4;2m");
        assert_eq!(
            m.wheel(&t, GEOMETRY, (30.0, 30.0), 2, Mods::empty()),
            b"\x1b[<64;4;2M\x1b[<64;4;2M"
        );
        assert_eq!(
            m.wheel(&t, GEOMETRY, (30.0, 30.0), -1, Mods::empty()),
            b"\x1b[<65;4;2M"
        );
    }

    #[test]
    fn cell_at_clamps() {
        assert_eq!(GEOMETRY.cell_at(0.0, 0.0, 20, 4), (0, 0));
        assert_eq!(GEOMETRY.cell_at(30.0, 30.0, 20, 4), (3, 1));
        assert_eq!(GEOMETRY.cell_at(1000.0, 1000.0, 20, 4), (19, 3));
    }
}
