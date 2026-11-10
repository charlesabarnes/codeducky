use serde::{Deserialize, Serialize};

use super::color::Oklch;
use super::swatches::*;

/// The TypeScript app's palettes, each with a light and a dark variant.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Palette {
    #[default]
    Solar,
    Terminal,
    Fjord,
    Dusk,
    Contrast,
}

impl Palette {
    pub const ALL: [Self; 5] = [
        Self::Solar,
        Self::Terminal,
        Self::Fjord,
        Self::Dusk,
        Self::Contrast,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::Solar => "solar",
            Self::Terminal => "terminal",
            Self::Fjord => "fjord",
            Self::Dusk => "dusk",
            Self::Contrast => "contrast",
        }
    }

    #[cfg(feature = "screenshot")]
    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.name() == name)
    }

    pub fn next(self) -> Self {
        let at = Self::ALL.iter().position(|p| *p == self).unwrap_or(0);
        Self::ALL[(at + 1) % Self::ALL.len()]
    }

    pub fn swatches(self, dark: bool) -> &'static Swatches {
        match (self, dark) {
            (Self::Solar, false) => &SOLAR_LIGHT,
            (Self::Solar, true) => &SOLAR_DARK,
            (Self::Terminal, false) => &TERMINAL_LIGHT,
            (Self::Terminal, true) => &TERMINAL_DARK,
            (Self::Fjord, false) => &FJORD_LIGHT,
            (Self::Fjord, true) => &FJORD_DARK,
            (Self::Dusk, false) => &DUSK_LIGHT,
            (Self::Dusk, true) => &DUSK_DARK,
            (Self::Contrast, false) => &CONTRAST_LIGHT,
            (Self::Contrast, true) => &CONTRAST_DARK,
        }
    }
}

/// The CSS custom properties a palette sets.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Swatches {
    pub bg: Oklch,
    pub bg_2: Oklch,
    pub bg_3: Oklch,
    pub fg: Oklch,
    pub fg_2: Oklch,
    pub line: Oklch,
    pub accent: Oklch,
    pub accent_fg: Oklch,
    pub add_fg: Oklch,
    pub add_bg: Oklch,
    pub add_strong: Oklch,
    pub del_fg: Oklch,
    pub del_bg: Oklch,
    pub del_strong: Oklch,
    pub mod_fg: Oklch,
    pub sev_s: Oklch,
    pub gap_bg: Oklch,
    pub moved_fg: Oklch,
    pub moved_add_bg: Oklch,
    pub moved_del_bg: Oklch,
    pub row_cur: Oklch,
    pub sx_f: Oklch,
    pub sx_k: Oklch,
    pub sx_s: Oklch,
    pub sx_n: Oklch,
    pub sx_c: Oklch,
}
