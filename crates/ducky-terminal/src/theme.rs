//! Terminal colours, and their mapping from the gpui-kit theme.

use gpui_kit::component::Theme;
use libghostty_vt::style::{Palette, RgbColor};

use crate::color::Rgb;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalColors {
    pub background: Rgb,
    pub foreground: Rgb,
    pub cursor: Rgb,
    pub selection_background: Rgb,
    /// Area outside the program's grid when another viewer set a smaller size.
    pub letterbox: Rgb,
    pub scrollbar_thumb: Rgb,
    pub link: Rgb,
    /// ANSI 0-15; 16-255 are generated from these plus background and foreground.
    pub ansi: [Rgb; 16],
}

impl TerminalColors {
    pub fn from_theme(theme: &Theme) -> Self {
        let c = |h| Rgb::from_hsla(h);
        let bg = c(theme.background);
        let fg = c(theme.foreground);
        let dark = theme.is_dark();
        let muted = c(theme.muted_foreground);
        let (black, white, bright_white) = if dark {
            (c(theme.muted), fg.mix(bg, 0.15), fg)
        } else {
            (fg, bg.mix(fg, 0.45), bg.mix(fg, 0.3))
        };
        let ansi = [
            black,
            c(theme.red),
            c(theme.green),
            c(theme.yellow),
            c(theme.blue),
            c(theme.magenta),
            c(theme.cyan),
            white,
            muted,
            c(theme.red_light),
            c(theme.green_light),
            c(theme.yellow_light),
            c(theme.blue_light),
            c(theme.magenta_light),
            c(theme.cyan_light),
            bright_white,
        ];
        Self {
            background: bg,
            foreground: fg,
            cursor: c(theme.caret),
            selection_background: c(theme.selection),
            letterbox: c(theme.muted),
            scrollbar_thumb: c(theme.scrollbar_thumb),
            link: c(theme.link),
            ansi,
        }
    }

    /// The 256-colour palette: ANSI 0-15 as given, the cube and grey ramp interpolated between
    /// background and foreground so 256-colour programs fit the theme.
    pub fn palette(&self) -> Palette {
        let mut base = Palette([RgbColor::default(); 256]);
        for (i, c) in self.ansi.iter().enumerate() {
            base.0[i] = (*c).into();
        }
        Palette::generate(
            Some(&base),
            None,
            self.background.into(),
            self.foreground.into(),
            false,
        )
    }
}

impl Default for TerminalColors {
    fn default() -> Self {
        let bg = Rgb::new(0x1e, 0x21, 0x27);
        let fg = Rgb::new(0xd8, 0xde, 0xe9);
        Self {
            background: bg,
            foreground: fg,
            cursor: fg,
            selection_background: Rgb::new(0x3b, 0x4a, 0x6b),
            letterbox: Rgb::new(0x2a, 0x2e, 0x36),
            scrollbar_thumb: Rgb::new(0x5a, 0x60, 0x6c),
            link: Rgb::new(0x81, 0xa1, 0xc1),
            ansi: [
                Rgb::new(0x3b, 0x42, 0x52),
                Rgb::new(0xbf, 0x61, 0x6a),
                Rgb::new(0xa3, 0xbe, 0x8c),
                Rgb::new(0xeb, 0xcb, 0x8b),
                Rgb::new(0x81, 0xa1, 0xc1),
                Rgb::new(0xb4, 0x8e, 0xad),
                Rgb::new(0x88, 0xc0, 0xd0),
                Rgb::new(0xe5, 0xe9, 0xf0),
                Rgb::new(0x4c, 0x56, 0x6a),
                Rgb::new(0xbf, 0x61, 0x6a),
                Rgb::new(0xa3, 0xbe, 0x8c),
                Rgb::new(0xeb, 0xcb, 0x8b),
                Rgb::new(0x81, 0xa1, 0xc1),
                Rgb::new(0xb4, 0x8e, 0xad),
                Rgb::new(0x8f, 0xbc, 0xbb),
                Rgb::new(0xec, 0xef, 0xf4),
            ],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn palette_keeps_ansi_and_fills_the_cube() {
        let colors = TerminalColors::default();
        let palette = colors.palette();
        for (i, c) in colors.ansi.iter().enumerate() {
            assert_eq!(Rgb::from(palette.0[i]), *c);
        }
        let ramp_start = Rgb::from(palette.0[232]);
        let ramp_end = Rgb::from(palette.0[255]);
        assert_ne!(ramp_start, ramp_end);
    }
}
