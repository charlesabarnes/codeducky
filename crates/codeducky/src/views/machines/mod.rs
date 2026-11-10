//! Machines: the picker on the start screen and in the title bar, adding, renaming and
//! forgetting them, and browsing folders on one.

pub mod add_dialog;
pub mod browser;
pub mod menu;
pub mod picker;
pub mod rename_dialog;

use ducky_session::machines::MachineState;
use gpui_kit::component::ActiveTheme;
use gpui_kit::*;

use crate::theme::ActiveCode;

pub fn state_dot(state: Option<&MachineState>, cx: &App) -> Div {
    let code = cx.code();
    let dot = div().size(px(8.)).flex_none().rounded_full();
    match state {
        None | Some(MachineState::Connected) => dot.bg(code.add),
        Some(MachineState::Connecting) => dot.border_1().border_color(code.accent),
        Some(MachineState::NeedsLogin) => dot.bg(code.modified),
        Some(MachineState::Unreachable) => dot.bg(code.del),
        Some(MachineState::Other(_)) => dot.border_1().border_color(cx.theme().muted_foreground),
    }
}

/// `this machine` or the name.
pub fn machine_label(machine: Option<&str>) -> String {
    machine.unwrap_or("this machine").to_owned()
}
