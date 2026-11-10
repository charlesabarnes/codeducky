use gpui_kit::{Hsla, Rgba};

/// A CSS `oklch(l c h)` colour: lightness 0-1, chroma, hue in degrees.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Oklch(pub f32, pub f32, pub f32);

impl Oklch {
    pub fn to_hsla(self) -> Hsla {
        let Oklch(l, c, h) = self;
        let (a, b) = (c * h.to_radians().cos(), c * h.to_radians().sin());
        let l_ = l + 0.396_337_78 * a + 0.215_803_76 * b;
        let m_ = l - 0.105_561_346 * a - 0.063_854_17 * b;
        let s_ = l - 0.089_484_18 * a - 1.291_485_5 * b;
        let (l3, m3, s3) = (l_.powi(3), m_.powi(3), s_.powi(3));
        let r = 4.076_741_7 * l3 - 3.307_711_6 * m3 + 0.230_969_94 * s3;
        let g = -1.268_438 * l3 + 2.609_757_4 * m3 - 0.341_319_38 * s3;
        let b = -0.004_196_086_3 * l3 - 0.703_418_6 * m3 + 1.707_614_7 * s3;
        Rgba {
            r: gamma(r),
            g: gamma(g),
            b: gamma(b),
            a: 1.0,
        }
        .into()
    }
}

fn gamma(linear: f32) -> f32 {
    let value = if linear <= 0.003_130_8 {
        12.92 * linear
    } else {
        1.055 * linear.powf(1.0 / 2.4) - 0.055
    };
    value.clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgb(color: Oklch) -> [u8; 3] {
        let rgba = Rgba::from(color.to_hsla());
        [rgba.r, rgba.g, rgba.b].map(|v| (v * 255.0).round() as u8)
    }

    #[test]
    fn converts_known_colours() {
        assert_eq!(rgb(Oklch(1.0, 0.0, 0.0)), [255, 255, 255]);
        assert_eq!(rgb(Oklch(0.0, 0.0, 0.0)), [0, 0, 0]);
        assert_eq!(rgb(Oklch(0.627_955, 0.257_683, 29.234)), [255, 0, 0]);
    }
}
