use gpui_kit::SharedString;

use crate::theme::TerminalColors;

#[derive(Clone, Debug)]
pub struct TerminalConfig {
    /// `None` uses the gpui-kit theme's monospace font.
    pub font_family: Option<SharedString>,
    pub font_size: f32,
    /// Multiple of the font size.
    pub line_height: f32,
    pub padding: f32,
    /// Scrollback lines requested from the source on attach.
    pub history: usize,
    pub scrollback_lines: usize,
    /// macOS: treat Option as Alt (Meta) instead of composing characters.
    pub option_as_alt: bool,
    /// Paste text that could run commands (newlines without bracketed paste) without asking.
    /// When false such a paste raises [`crate::TerminalEvent::UnsafePaste`] instead.
    pub allow_unsafe_paste: bool,
    /// `None` follows the gpui-kit theme, light or dark.
    pub colors: Option<TerminalColors>,
    pub cursor_blink: bool,
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self {
            font_family: None,
            font_size: 13.0,
            line_height: 1.25,
            padding: 6.0,
            history: 1000,
            scrollback_lines: 10_000,
            option_as_alt: false,
            allow_unsafe_paste: false,
            colors: None,
            cursor_blink: true,
        }
    }
}
