//! The look: palette × light/dark × density, applied onto gpui-kit's theme, plus the review
//! colours gpui-kit has no slot for.

mod color;
mod density;
mod palette;
mod swatches;

use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::*;
use serde::{Deserialize, Serialize};

pub use density::{Density, Metrics};
pub use palette::Palette;

use ducky_review::Severity;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    #[default]
    System,
    Light,
    Dark,
}

impl Appearance {
    #[cfg(feature = "screenshot")]
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "system" => Some(Self::System),
            "light" => Some(Self::Light),
            "dark" => Some(Self::Dark),
            _ => None,
        }
    }

    pub fn next(self) -> Self {
        match self {
            Self::System => Self::Light,
            Self::Light => Self::Dark,
            Self::Dark => Self::System,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }

    fn is_dark(self, window: Option<&Window>, cx: &App) -> bool {
        match self {
            Self::Light => false,
            Self::Dark => true,
            Self::System => {
                let appearance = window.map_or_else(|| cx.window_appearance(), Window::appearance);
                matches!(
                    appearance,
                    WindowAppearance::Dark | WindowAppearance::VibrantDark
                )
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Look {
    pub appearance: Appearance,
    pub palette: Palette,
    pub density: Density,
}

/// Review colours the kit theme has no slot for.
#[derive(Debug, Clone, Copy)]
pub struct CodeColors {
    pub accent: Hsla,
    pub accent_fg: Hsla,
    pub fg_2: Hsla,
    pub bg_2: Hsla,
    pub bg_3: Hsla,
    pub add: Hsla,
    pub del: Hsla,
    pub modified: Hsla,
    pub moved: Hsla,
    pub moved_add_bg: Hsla,
    pub moved_del_bg: Hsla,
    pub gap_bg: Hsla,
    pub row_current: Hsla,
    pub suggestion: Hsla,
    pub metrics: Metrics,
}

impl Global for CodeColors {}

impl CodeColors {
    pub fn severity(&self, severity: Severity) -> Hsla {
        match severity {
            Severity::Nit => self.fg_2,
            Severity::Suggestion => self.suggestion,
            Severity::Issue => self.modified,
            Severity::Blocker => self.del,
        }
    }
}

pub trait ActiveCode {
    fn code(&self) -> &CodeColors;
}

impl ActiveCode for App {
    fn code(&self) -> &CodeColors {
        self.global::<CodeColors>()
    }
}

pub fn apply(look: Look, window: Option<&Window>, cx: &mut App) {
    let dark = look.appearance.is_dark(window, cx);
    let mode = if dark {
        ThemeMode::Dark
    } else {
        ThemeMode::Light
    };
    Theme::change(mode, None, cx);
    let s = look.palette.swatches(dark);
    let metrics = look.density.metrics();
    Theme::update(cx, |theme| {
        let c = |o: color::Oklch| o.to_hsla();
        theme.font_size = metrics.ui_font;
        theme.mono_font_size = metrics.code;
        theme.radius = px(3.);
        theme.radius_lg = px(5.);
        theme.shadow = false;
        let t = &mut theme.colors;
        t.background = c(s.bg);
        t.foreground = c(s.fg);
        t.muted = c(s.bg_2);
        t.muted_foreground = c(s.fg_2);
        t.border = c(s.line);
        t.input = c(s.line);
        t.ring = c(s.accent);
        t.caret = c(s.fg);
        t.primary = c(s.accent);
        t.primary_hover = c(s.accent).opacity(0.9);
        t.primary_active = c(s.accent).opacity(0.8);
        t.primary_foreground = c(s.accent_fg);
        t.accent = c(s.bg_3);
        t.accent_foreground = c(s.fg);
        t.secondary = c(s.bg_2);
        t.secondary_hover = c(s.bg_3);
        t.secondary_active = c(s.bg_3);
        t.secondary_foreground = c(s.fg);
        t.sidebar = c(s.bg);
        t.sidebar_foreground = c(s.fg);
        t.sidebar_border = c(s.line);
        t.sidebar_accent = c(s.bg_3);
        t.sidebar_accent_foreground = c(s.fg);
        t.sidebar_primary = c(s.accent);
        t.sidebar_primary_foreground = c(s.accent_fg);
        t.title_bar = c(s.bg_2);
        t.title_bar_border = c(s.line);
        t.status_bar = c(s.bg_2);
        t.status_bar_border = c(s.line);
        t.list = c(s.bg);
        t.list_even = c(s.bg);
        t.list_head = c(s.bg_2);
        t.list_hover = c(s.bg_2);
        t.list_active = c(s.row_cur);
        t.list_active_border = c(s.accent);
        t.popover = c(s.bg);
        t.popover_foreground = c(s.fg);
        t.selection = c(s.accent).opacity(0.3);
        t.success = c(s.add_fg);
        t.danger = c(s.del_fg);
        t.warning = c(s.mod_fg);
        t.info = c(s.sev_s);
        t.link = c(s.sev_s);
        t.tab_bar = c(s.bg_2);
        t.tab = c(s.bg_2);
        t.tab_active = c(s.bg);
        t.tab_foreground = c(s.fg_2);
        t.tab_active_foreground = c(s.fg);
        t.scrollbar = c(s.bg).opacity(0.);
        t.scrollbar_thumb = c(s.line);
        t.scrollbar_thumb_hover = c(s.fg_2);
        t.window_border = c(s.line);
    });
    let c = |o: color::Oklch| o.to_hsla();
    cx.set_global(CodeColors {
        accent: c(s.accent),
        accent_fg: c(s.accent_fg),
        fg_2: c(s.fg_2),
        bg_2: c(s.bg_2),
        bg_3: c(s.bg_3),
        add: c(s.add_fg),
        del: c(s.del_fg),
        modified: c(s.mod_fg),
        moved: c(s.moved_fg),
        moved_add_bg: c(s.moved_add_bg),
        moved_del_bg: c(s.moved_del_bg),
        gap_bg: c(s.gap_bg),
        row_current: c(s.row_cur),
        suggestion: c(s.sev_s),
        metrics,
    });
}
