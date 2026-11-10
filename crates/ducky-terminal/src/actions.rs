//! Terminal actions and their key bindings, scoped to the terminal's own key context so the
//! app's (and gpui-kit's) bindings for tab, shift-tab and friends do not take its keys.

use gpui_kit::{App, KeyBinding, actions};

pub const KEY_CONTEXT: &str = "Terminal";

actions!(
    terminal,
    [
        Copy,
        Paste,
        SelectAll,
        SendTab,
        SendBackTab,
        ScrollPageUp,
        ScrollPageDown,
        ScrollToTop,
        ScrollToBottom,
    ]
);

/// `KeyBinding::new` has no `secondary-` modifier, so pick cmd or ctrl-shift per platform.
pub fn bindings() -> Vec<KeyBinding> {
    let ctx = Some(KEY_CONTEXT);
    let (copy, paste, select_all, top, bottom) = if cfg!(target_os = "macos") {
        ("cmd-c", "cmd-v", "cmd-a", "cmd-up", "cmd-down")
    } else {
        (
            "ctrl-shift-c",
            "ctrl-shift-v",
            "ctrl-shift-a",
            "ctrl-shift-home",
            "ctrl-shift-end",
        )
    };
    vec![
        KeyBinding::new(copy, Copy, ctx),
        KeyBinding::new(paste, Paste, ctx),
        KeyBinding::new(select_all, SelectAll, ctx),
        KeyBinding::new(top, ScrollToTop, ctx),
        KeyBinding::new(bottom, ScrollToBottom, ctx),
        KeyBinding::new("tab", SendTab, ctx),
        KeyBinding::new("shift-tab", SendBackTab, ctx),
        KeyBinding::new("shift-pageup", ScrollPageUp, ctx),
        KeyBinding::new("shift-pagedown", ScrollPageDown, ctx),
    ]
}

/// Binds the terminal's keys; call once at startup.
pub fn init(cx: &mut App) {
    cx.bind_keys(bindings());
}
