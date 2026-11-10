use gpui_kit::{Hsla, Rgba};
use libghostty_vt::style::RgbColor;

/// An opaque 8-bit RGB colour; the frame model uses it so it stays free of GPUI types.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    pub const fn new(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b }
    }

    /// Linear blend towards `other`; `t = 0` is `self`.
    pub fn mix(self, other: Rgb, t: f32) -> Rgb {
        let lerp = |a: u8, b: u8| (f32::from(a) + (f32::from(b) - f32::from(a)) * t).round() as u8;
        Rgb::new(
            lerp(self.r, other.r),
            lerp(self.g, other.g),
            lerp(self.b, other.b),
        )
    }

    pub fn to_hex(self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.r, self.g, self.b)
    }

    pub fn hsla(self) -> Hsla {
        Rgba {
            r: f32::from(self.r) / 255.0,
            g: f32::from(self.g) / 255.0,
            b: f32::from(self.b) / 255.0,
            a: 1.0,
        }
        .into()
    }

    pub fn from_hsla(color: Hsla) -> Rgb {
        let rgba: Rgba = color.to_rgb();
        let c = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        Rgb::new(c(rgba.r), c(rgba.g), c(rgba.b))
    }
}

impl From<RgbColor> for Rgb {
    fn from(c: RgbColor) -> Self {
        Rgb::new(c.r, c.g, c.b)
    }
}

impl From<Rgb> for RgbColor {
    fn from(c: Rgb) -> Self {
        RgbColor {
            r: c.r,
            g: c.g,
            b: c.b,
        }
    }
}
