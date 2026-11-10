//! App icons from the pixel-art duck in `assets/codeducky.svg`.
//!
//! The SVG is a 32x32 grid of axis-aligned rectangles (`M x y h w v 1 h -w z`
//! per run), so it is rasterised cell by cell and scaled with nearest
//! neighbour to keep every pixel crisp. Anything outside that subset is an
//! error rather than a blurry guess.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, bail, ensure};
use image::{Rgba, RgbaImage, imageops};

const GRID: u32 = 32;
/// The hicolor sizes Linux desktops look up, and the macOS iconset sizes.
pub const SIZES: [u32; 8] = [16, 32, 48, 64, 128, 256, 512, 1024];

pub fn source(root: &Path) -> PathBuf {
    root.join("assets/codeducky.svg")
}

pub fn out_dir(root: &Path) -> PathBuf {
    root.join("assets/icons")
}

/// Writes `assets/icons/codeducky-<size>.png` for every size in [`SIZES`].
pub fn generate(root: &Path) -> anyhow::Result<()> {
    let svg = fs::read_to_string(source(root))?;
    let grid = rasterise(&svg)?;
    let dir = out_dir(root);
    fs::create_dir_all(&dir)?;
    for size in SIZES {
        let path = dir.join(format!("codeducky-{size}.png"));
        scale(&grid, size).save(&path)?;
        println!("wrote {}", path.display());
    }
    Ok(())
}

pub fn png(root: &Path, size: u32) -> anyhow::Result<PathBuf> {
    let path = out_dir(root).join(format!("codeducky-{size}.png"));
    ensure!(
        path.is_file(),
        "{} is missing; run `cargo xtask icons`",
        path.display()
    );
    Ok(path)
}

/// Nearest neighbour both ways. 16 and 48 are not multiples of 32, so they
/// sample the grid instead of repeating it; 32 is the art's native size.
fn scale(grid: &RgbaImage, size: u32) -> RgbaImage {
    imageops::resize(grid, size, size, imageops::FilterType::Nearest)
}

fn rasterise(svg: &str) -> anyhow::Result<RgbaImage> {
    let mut image = RgbaImage::new(GRID, GRID);
    let mut paths = 0;
    for element in svg.split("<path").skip(1) {
        let fill = attribute(element, "fill").context("path without fill")?;
        let d = attribute(element, "d").context("path without d")?;
        let colour = parse_colour(fill)?;
        for (x, y, w, h) in rects(d)? {
            for py in y..y + h {
                for px in x..x + w {
                    ensure!(px < GRID && py < GRID, "rect outside the 32x32 grid");
                    image.put_pixel(px, py, colour);
                }
            }
        }
        paths += 1;
    }
    ensure!(paths > 0, "no <path> elements in the SVG");
    Ok(image)
}

fn attribute<'a>(element: &'a str, name: &str) -> Option<&'a str> {
    let start = element.find(&format!(" {name}=\""))? + name.len() + 3;
    let len = element[start..].find('"')?;
    Some(&element[start..start + len])
}

fn parse_colour(fill: &str) -> anyhow::Result<Rgba<u8>> {
    let hex = fill.strip_prefix('#').context("fill must be #rrggbb")?;
    ensure!(hex.len() == 6, "fill must be #rrggbb, got {fill}");
    let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16);
    Ok(Rgba([byte(0)?, byte(2)?, byte(4)?, 255]))
}

/// `M x y h w v h h -w z` runs into `(x, y, w, h)`.
fn rects(d: &str) -> anyhow::Result<Vec<(u32, u32, u32, u32)>> {
    let mut out = Vec::new();
    for run in d.split('M').map(str::trim).filter(|r| !r.is_empty()) {
        let run = run.strip_suffix('z').context("run must end with z")?;
        let (start, rest) = run.split_once('h').context("run must start with M x y h")?;
        let (w, rest) = rest.split_once('v').context("run must continue with v")?;
        let (h, back) = rest.split_once('h').context("run must close with h")?;
        let mut xy = start.split_whitespace();
        let (Some(x), Some(y), None) = (xy.next(), xy.next(), xy.next()) else {
            bail!("bad start in run {run:?}");
        };
        let w: u32 = w.trim().parse()?;
        ensure!(
            back.trim() == format!("-{w}"),
            "run is not a rectangle: {run:?}"
        );
        out.push((x.parse()?, y.parse()?, w, h.trim().parse()?));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rect_runs() {
        assert_eq!(
            rects("M11 5h4v1h-4zM9 6h2v2h-2z").unwrap(),
            vec![(11, 5, 4, 1), (9, 6, 2, 2)]
        );
        assert!(rects("M1 1h2v1h-3z").is_err());
    }

    #[test]
    fn scales_crisply() {
        let mut grid = RgbaImage::new(GRID, GRID);
        grid.put_pixel(3, 4, Rgba([1, 2, 3, 255]));
        let big = scale(&grid, 512);
        assert_eq!(big.get_pixel(3 * 16, 4 * 16), &Rgba([1, 2, 3, 255]));
        assert_eq!(
            big.get_pixel(3 * 16 + 15, 4 * 16 + 15),
            &Rgba([1, 2, 3, 255])
        );
        assert_eq!(big.get_pixel(3 * 16 + 16, 4 * 16), &Rgba([0, 0, 0, 0]));
    }
}
