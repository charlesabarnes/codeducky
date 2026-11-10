//! GPUI keystrokes to bytes, through libghostty's key encoder (legacy, xterm and kitty).

use gpui_kit::Keystroke;
use libghostty_vt::key::{self, Key, KittyKeyFlags, Mods, OptionAsAlt};

use crate::emulator::Emulator;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct KeyOptions {
    pub option_as_alt: bool,
}

/// What to do with a key-down.
#[derive(Debug, PartialEq, Eq)]
pub enum KeyRoute {
    /// Platform (cmd) shortcuts belong to the app.
    Ignore,
    /// Plain text: let the platform's text input (IME, dead keys) produce it.
    Text,
    Encode,
}

pub fn route(keystroke: &Keystroke, kitty: KittyKeyFlags, options: KeyOptions) -> KeyRoute {
    let m = keystroke.modifiers;
    if m.platform {
        return KeyRoute::Ignore;
    }
    let printable = keystroke
        .key_char
        .as_deref()
        .is_some_and(|t| !t.is_empty() && !t.chars().any(char::is_control));
    let reports_text_as_keys = kitty.contains(KittyKeyFlags::REPORT_ALL);
    if printable && !m.control && !alt_is_meta(m.alt, options) && !reports_text_as_keys {
        return KeyRoute::Text;
    }
    if map_key(&keystroke.key).is_none() {
        return if printable {
            KeyRoute::Text
        } else {
            KeyRoute::Ignore
        };
    }
    KeyRoute::Encode
}

fn alt_is_meta(alt: bool, options: KeyOptions) -> bool {
    alt && (options.option_as_alt || !cfg!(target_os = "macos"))
}

pub struct KeyEncoder {
    encoder: key::Encoder<'static>,
    event: key::Event<'static>,
}

impl KeyEncoder {
    pub fn new() -> Result<Self, libghostty_vt::Error> {
        Ok(Self {
            encoder: key::Encoder::new()?,
            event: key::Event::new()?,
        })
    }

    pub fn encode(
        &mut self,
        terminal: &Emulator,
        keystroke: &Keystroke,
        is_held: bool,
        options: KeyOptions,
    ) -> Vec<u8> {
        let Some((gkey, unshifted)) = map_key(&keystroke.key) else {
            return Vec::new();
        };
        let m = keystroke.modifiers;
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
        let text = keystroke
            .key_char
            .clone()
            .filter(|t| !m.control && !t.chars().any(char::is_control));
        let mut consumed = Mods::empty();
        if text.is_some() && m.shift && unshifted != '\0' {
            consumed |= Mods::SHIFT;
        }
        if text.is_some() && m.alt && !alt_is_meta(true, options) {
            consumed |= Mods::ALT;
        }
        self.event
            .set_action(if is_held {
                key::Action::Repeat
            } else {
                key::Action::Press
            })
            .set_key(gkey)
            .set_mods(mods)
            .set_consumed_mods(consumed)
            .set_unshifted_codepoint(unshifted)
            .set_utf8(text);
        let mut out = Vec::with_capacity(16);
        self.encoder
            .set_options_from_terminal(terminal)
            .set_macos_option_as_alt(if options.option_as_alt {
                OptionAsAlt::True
            } else {
                OptionAsAlt::False
            });
        let _ = self.encoder.encode_to_vec(&self.event, &mut out);
        out
    }
}

/// GPUI key name to a physical key and the character it types unshifted (`\0` for none).
pub fn map_key(name: &str) -> Option<(Key, char)> {
    let k = match name {
        "enter" => (Key::Enter, '\0'),
        "tab" => (Key::Tab, '\0'),
        "backspace" => (Key::Backspace, '\0'),
        "escape" => (Key::Escape, '\0'),
        "space" | " " => (Key::Space, ' '),
        "delete" => (Key::Delete, '\0'),
        "insert" => (Key::Insert, '\0'),
        "home" => (Key::Home, '\0'),
        "end" => (Key::End, '\0'),
        "pageup" => (Key::PageUp, '\0'),
        "pagedown" => (Key::PageDown, '\0'),
        "up" => (Key::ArrowUp, '\0'),
        "down" => (Key::ArrowDown, '\0'),
        "left" => (Key::ArrowLeft, '\0'),
        "right" => (Key::ArrowRight, '\0'),
        "f1" => (Key::F1, '\0'),
        "f2" => (Key::F2, '\0'),
        "f3" => (Key::F3, '\0'),
        "f4" => (Key::F4, '\0'),
        "f5" => (Key::F5, '\0'),
        "f6" => (Key::F6, '\0'),
        "f7" => (Key::F7, '\0'),
        "f8" => (Key::F8, '\0'),
        "f9" => (Key::F9, '\0'),
        "f10" => (Key::F10, '\0'),
        "f11" => (Key::F11, '\0'),
        "f12" => (Key::F12, '\0'),
        "`" => (Key::Backquote, '`'),
        "\\" => (Key::Backslash, '\\'),
        "[" => (Key::BracketLeft, '['),
        "]" => (Key::BracketRight, ']'),
        "," => (Key::Comma, ','),
        "=" => (Key::Equal, '='),
        "-" => (Key::Minus, '-'),
        "." => (Key::Period, '.'),
        "'" => (Key::Quote, '\''),
        ";" => (Key::Semicolon, ';'),
        "/" => (Key::Slash, '/'),
        s => {
            let mut chars = s.chars();
            let c = chars.next()?.to_ascii_lowercase();
            if chars.next().is_some() {
                return None;
            }
            let key = match c {
                'a'..='z' => LETTERS[usize::from(c as u8 - b'a')],
                '0'..='9' => DIGITS[usize::from(c as u8 - b'0')],
                _ => return None,
            };
            (key, c)
        }
    };
    Some(k)
}

#[rustfmt::skip]
const LETTERS: [Key; 26] = [
    Key::A, Key::B, Key::C, Key::D, Key::E, Key::F, Key::G, Key::H, Key::I, Key::J, Key::K, Key::L,
    Key::M, Key::N, Key::O, Key::P, Key::Q, Key::R, Key::S, Key::T, Key::U, Key::V, Key::W, Key::X,
    Key::Y, Key::Z,
];
#[rustfmt::skip]
const DIGITS: [Key; 10] = [
    Key::Digit0, Key::Digit1, Key::Digit2, Key::Digit3, Key::Digit4, Key::Digit5, Key::Digit6,
    Key::Digit7, Key::Digit8, Key::Digit9,
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::emulator::new_emulator;
    use crate::source::GridSize;
    use crate::theme::TerminalColors;
    use gpui_kit::Modifiers;

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

    fn ks(spec: &'static str) -> Keystroke {
        let mut k = Keystroke::parse(spec).unwrap();
        if k.key_char.is_none() && k.key.chars().count() == 1 && !k.modifiers.control {
            let c = k.key.clone();
            k.key_char = Some(if k.modifiers.shift {
                c.to_uppercase()
            } else {
                c
            });
        }
        k
    }

    fn encode(t: &Emulator, spec: &'static str) -> Vec<u8> {
        KeyEncoder::new()
            .unwrap()
            .encode(t, &ks(spec), false, KeyOptions::default())
    }

    #[test]
    fn plain_text_goes_through_text_input() {
        let flags = KittyKeyFlags::empty();
        let opts = KeyOptions::default();
        assert_eq!(route(&ks("a"), flags, opts), KeyRoute::Text);
        assert_eq!(route(&ks("shift-a"), flags, opts), KeyRoute::Text);
        assert_eq!(route(&ks("ctrl-c"), flags, opts), KeyRoute::Encode);
        assert_eq!(route(&ks("enter"), flags, opts), KeyRoute::Encode);
        assert_eq!(route(&ks("cmd-c"), flags, opts), KeyRoute::Ignore);
        assert_eq!(
            route(&ks("a"), KittyKeyFlags::REPORT_ALL, opts),
            KeyRoute::Encode
        );
    }

    #[test]
    fn option_routes_by_platform_and_setting() {
        let mut k = ks("alt-b");
        k.key_char = Some("∫".into());
        let flags = KittyKeyFlags::empty();
        let meta = KeyOptions {
            option_as_alt: true,
        };
        assert_eq!(route(&k, flags, meta), KeyRoute::Encode);
        let expected = if cfg!(target_os = "macos") {
            KeyRoute::Text
        } else {
            KeyRoute::Encode
        };
        assert_eq!(route(&k, flags, KeyOptions::default()), expected);
        let t = terminal();
        let out = KeyEncoder::new().unwrap().encode(&t, &k, false, meta);
        assert_eq!(out, b"\x1bb");
    }

    #[test]
    fn legacy_encoding() {
        let mut t = terminal();
        assert_eq!(encode(&t, "ctrl-c"), b"\x03");
        assert_eq!(encode(&t, "enter"), b"\r");
        assert_eq!(encode(&t, "backspace"), b"\x7f");
        assert_eq!(encode(&t, "escape"), b"\x1b");
        assert_eq!(encode(&t, "up"), b"\x1b[A");
        assert_eq!(encode(&t, "shift-tab"), b"\x1b[Z");
        assert_eq!(encode(&t, "tab"), b"\t");
        assert_eq!(encode(&t, "ctrl-left"), b"\x1b[1;5D");
        t.vt_write(b"\x1b[?1h");
        assert_eq!(encode(&t, "up"), b"\x1bOA");
    }

    #[test]
    fn kitty_protocol_when_the_program_asks() {
        let mut t = terminal();
        t.vt_write(b"\x1b[>1u");
        assert_eq!(encode(&t, "escape"), b"\x1b[27u");
        assert_eq!(encode(&t, "ctrl-c"), b"\x1b[99;5u");
        let shift_enter = Keystroke {
            modifiers: Modifiers {
                shift: true,
                ..Default::default()
            },
            key: "enter".into(),
            key_char: None,
        };
        let out = KeyEncoder::new()
            .unwrap()
            .encode(&t, &shift_enter, false, KeyOptions::default());
        assert_eq!(out, b"\x1b[13;2u");
    }
}
