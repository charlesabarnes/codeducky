use gpui_kit::{Pixels, px};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Density {
    Compact,
    #[default]
    Default,
    Comfortable,
}

/// Sizes that follow the density, from the TypeScript app's `styles.css`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Metrics {
    pub ui_font: Pixels,
    pub text: Pixels,
    pub code: Pixels,
    pub row: Pixels,
    pub bar: Pixels,
    pub status: Pixels,
    pub pad_x: Pixels,
    pub pad_y: Pixels,
    pub sidebar: Pixels,
}

impl Density {
    #[cfg(feature = "screenshot")]
    pub const ALL: [Self; 3] = [Self::Compact, Self::Default, Self::Comfortable];

    pub fn name(self) -> &'static str {
        match self {
            Self::Compact => "compact",
            Self::Default => "default",
            Self::Comfortable => "comfortable",
        }
    }

    #[cfg(feature = "screenshot")]
    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|d| d.name() == name)
    }

    pub fn next(self) -> Self {
        match self {
            Self::Compact => Self::Default,
            Self::Default => Self::Comfortable,
            Self::Comfortable => Self::Compact,
        }
    }

    pub fn metrics(self) -> Metrics {
        match self {
            Self::Compact => Metrics {
                ui_font: px(13.),
                text: px(11.),
                code: px(11.),
                row: px(20.),
                bar: px(28.),
                status: px(20.),
                pad_x: px(8.),
                pad_y: px(4.),
                sidebar: px(300.),
            },
            Self::Default => Metrics {
                ui_font: px(14.),
                text: px(12.),
                code: px(12.),
                row: px(22.),
                bar: px(32.),
                status: px(22.),
                pad_x: px(12.),
                pad_y: px(6.),
                sidebar: px(320.),
            },
            Self::Comfortable => Metrics {
                ui_font: px(15.),
                text: px(13.),
                code: px(13.),
                row: px(26.),
                bar: px(38.),
                status: px(26.),
                pad_x: px(16.),
                pad_y: px(8.),
                sidebar: px(352.),
            },
        }
    }
}
