//! A configured libghostty `Terminal` and the effects its callbacks collect.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use libghostty_vt::Terminal;
use libghostty_vt::terminal::{
    ConformanceLevel, DeviceAttributeFeature, DeviceAttributes, DeviceType,
    PrimaryDeviceAttributes, SecondaryDeviceAttributes, SizeReportSize,
};

use crate::source::GridSize;
use crate::theme::TerminalColors;

pub type Emulator = Terminal<'static, 'static>;

/// What the callbacks saw during the last `vt_write` or `paste`.
#[derive(Default)]
pub struct Effects {
    pub pty_writes: Vec<u8>,
    pub title: Option<String>,
    pub pwd: Option<String>,
    pub bell: bool,
}

pub struct EffectsHandle {
    effects: Rc<RefCell<Effects>>,
    size: Rc<Cell<GridSize>>,
}

impl EffectsHandle {
    pub fn take(&self) -> Effects {
        std::mem::take(&mut *self.effects.borrow_mut())
    }

    pub fn set_size(&self, size: GridSize) {
        self.size.set(size);
    }
}

pub fn new_emulator(
    size: GridSize,
    colors: &TerminalColors,
    scrollback_lines: usize,
) -> Result<(Emulator, EffectsHandle), libghostty_vt::Error> {
    let mut terminal: Emulator = Terminal::new(size.cols, size.rows)?;
    terminal
        .set_scrollback_max_lines(Some(scrollback_lines))?
        .set_terminfo_name("xterm-256color")?;
    terminal.resize(size.cols, size.rows, size.cell_width, size.cell_height)?;
    apply_colors(&mut terminal, colors)?;

    let effects = Rc::new(RefCell::new(Effects::default()));
    let grid = Rc::new(Cell::new(size));
    let e = effects.clone();
    terminal.on_pty_write(move |_, data| e.borrow_mut().pty_writes.extend_from_slice(data))?;
    let e = effects.clone();
    terminal.on_bell(move |_| e.borrow_mut().bell = true)?;
    let e = effects.clone();
    terminal.on_title_changed(move |t| {
        e.borrow_mut().title = Some(lossy(t.title().unwrap_or_default()));
    })?;
    let e = effects.clone();
    terminal.on_pwd_changed(move |t| {
        e.borrow_mut().pwd = Some(lossy(t.pwd().unwrap_or_default()));
    })?;
    let g = grid.clone();
    terminal.on_size(move |_| {
        let size = g.get();
        Some(SizeReportSize {
            rows: size.rows,
            columns: size.cols,
            cell_width: size.cell_width,
            cell_height: size.cell_height,
        })
    })?;
    terminal.on_device_attributes(|_| {
        Some(DeviceAttributes {
            primary: PrimaryDeviceAttributes::new(
                ConformanceLevel::VT220,
                &[
                    DeviceAttributeFeature::COLUMNS_132,
                    DeviceAttributeFeature::SELECTIVE_ERASE,
                    DeviceAttributeFeature::ANSI_COLOR,
                ],
            ),
            secondary: SecondaryDeviceAttributes {
                device_type: DeviceType::VT220,
                firmware_version: 1,
                rom_cartridge: 0,
            },
            tertiary: Default::default(),
        })
    })?;
    terminal.on_xtversion(|_| Some("codeducky"))?;
    Ok((
        terminal,
        EffectsHandle {
            effects,
            size: grid,
        },
    ))
}

pub fn apply_colors(
    terminal: &mut Emulator,
    colors: &TerminalColors,
) -> Result<(), libghostty_vt::Error> {
    terminal
        .set_default_fg_color(Some(colors.foreground.into()))?
        .set_default_bg_color(Some(colors.background.into()))?
        .set_default_cursor_color(Some(colors.cursor.into()))?
        .set_default_color_palette(Some(colors.palette()))?;
    Ok(())
}

pub fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}
