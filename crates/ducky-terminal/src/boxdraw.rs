//! Box-drawing (U+2500-257F) and block (U+2580-259F) characters as shapes in cell coordinates.
//! Font glyphs for these rarely fill the line height, which leaves gaps between rows in TUI
//! borders and logos; shapes sized to the cell join exactly.

#[derive(Clone, Debug, PartialEq)]
pub enum Prim {
    /// Filled rectangle; `alpha` < 1 for shade characters.
    Rect {
        x0: f32,
        y0: f32,
        x1: f32,
        y1: f32,
        alpha: f32,
    },
    /// Stroked polyline; `Quad` segments are quadratic curves.
    Stroke { ops: Vec<PathOp>, width: f32 },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PathOp {
    Move(f32, f32),
    Line(f32, f32),
    Quad { to: (f32, f32), ctrl: (f32, f32) },
}

pub fn is_procedural(ch: char) -> bool {
    matches!(ch as u32, 0x2500..=0x259F)
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Weight {
    None = 0,
    Light = 1,
    Heavy = 2,
    Double = 3,
}

/// Arms (up, right, down, left) of U+2500-254B and U+2550-256C, U+2574-257F, as digits.
#[rustfmt::skip]
const ARMS: &[(u32, &str)] = &[
    (0x2500, "0101"), (0x2501, "0202"), (0x2502, "1010"), (0x2503, "2020"),
    (0x250C, "0110"), (0x250D, "0210"), (0x250E, "0120"), (0x250F, "0220"),
    (0x2510, "0011"), (0x2511, "0012"), (0x2512, "0021"), (0x2513, "0022"),
    (0x2514, "1100"), (0x2515, "1200"), (0x2516, "2100"), (0x2517, "2200"),
    (0x2518, "1001"), (0x2519, "1002"), (0x251A, "2001"), (0x251B, "2002"),
    (0x251C, "1110"), (0x251D, "1210"), (0x251E, "2110"), (0x251F, "1120"),
    (0x2520, "2120"), (0x2521, "2210"), (0x2522, "1220"), (0x2523, "2220"),
    (0x2524, "1011"), (0x2525, "1012"), (0x2526, "2011"), (0x2527, "1021"),
    (0x2528, "2021"), (0x2529, "2012"), (0x252A, "1022"), (0x252B, "2022"),
    (0x252C, "0111"), (0x252D, "0112"), (0x252E, "0211"), (0x252F, "0212"),
    (0x2530, "0121"), (0x2531, "0122"), (0x2532, "0221"), (0x2533, "0222"),
    (0x2534, "1101"), (0x2535, "1102"), (0x2536, "1201"), (0x2537, "1202"),
    (0x2538, "2101"), (0x2539, "2102"), (0x253A, "2201"), (0x253B, "2202"),
    (0x253C, "1111"), (0x253D, "1112"), (0x253E, "1211"), (0x253F, "1212"),
    (0x2540, "2111"), (0x2541, "1121"), (0x2542, "2121"), (0x2543, "2112"),
    (0x2544, "2211"), (0x2545, "1122"), (0x2546, "1221"), (0x2547, "2212"),
    (0x2548, "1222"), (0x2549, "2122"), (0x254A, "2221"), (0x254B, "2222"),
    (0x2550, "0303"), (0x2551, "3030"), (0x2552, "0310"), (0x2553, "0130"),
    (0x2554, "0330"), (0x2555, "0013"), (0x2556, "0031"), (0x2557, "0033"),
    (0x2558, "1300"), (0x2559, "3100"), (0x255A, "3300"), (0x255B, "1003"),
    (0x255C, "3001"), (0x255D, "3003"), (0x255E, "1310"), (0x255F, "3130"),
    (0x2560, "3330"), (0x2561, "1013"), (0x2562, "3031"), (0x2563, "3033"),
    (0x2564, "0313"), (0x2565, "0131"), (0x2566, "0333"), (0x2567, "1303"),
    (0x2568, "3101"), (0x2569, "3303"), (0x256A, "1313"), (0x256B, "3131"),
    (0x256C, "3333"),
    (0x2574, "0001"), (0x2575, "1000"), (0x2576, "0100"), (0x2577, "0010"),
    (0x2578, "0002"), (0x2579, "2000"), (0x257A, "0200"), (0x257B, "0020"),
    (0x257C, "0201"), (0x257D, "1020"), (0x257E, "0102"), (0x257F, "2010"),
];

/// Dashed lines: (code, horizontal, heavy, dashes).
#[rustfmt::skip]
const DASHES: &[(u32, bool, bool, u8)] = &[
    (0x2504, true, false, 3), (0x2505, true, true, 3), (0x2506, false, false, 3),
    (0x2507, false, true, 3), (0x2508, true, false, 4), (0x2509, true, true, 4),
    (0x250A, false, false, 4), (0x250B, false, true, 4), (0x254C, true, false, 2),
    (0x254D, true, true, 2), (0x254E, false, false, 2), (0x254F, false, true, 2),
];

/// Shapes for `ch` in a `w` x `h` cell with light lines `light` wide. `None` if not procedural.
pub fn shapes(ch: char, w: f32, h: f32, light: f32) -> Option<Vec<Prim>> {
    let code = ch as u32;
    if let Some(prims) = block(code, w, h) {
        return Some(prims);
    }
    if let Some(&(_, digits)) = ARMS.iter().find(|(c, _)| *c == code) {
        let arms = parse_arms(digits);
        return Some(lines(arms, w, h, light));
    }
    if let Some(&(_, horizontal, heavy, n)) = DASHES.iter().find(|(c, ..)| *c == code) {
        return Some(dashes(
            horizontal,
            if heavy { light * 2.0 } else { light },
            n,
            w,
            h,
        ));
    }
    match code {
        0x256D..=0x2570 => Some(vec![arc(code, w, h, light)]),
        0x2571 => Some(vec![diagonal(true, w, h, light)]),
        0x2572 => Some(vec![diagonal(false, w, h, light)]),
        0x2573 => Some(vec![
            diagonal(true, w, h, light),
            diagonal(false, w, h, light),
        ]),
        _ => None,
    }
}

fn parse_arms(digits: &str) -> [Weight; 4] {
    let mut out = [Weight::None; 4];
    for (i, d) in digits.bytes().enumerate().take(4) {
        out[i] = match d {
            b'1' => Weight::Light,
            b'2' => Weight::Heavy,
            b'3' => Weight::Double,
            _ => Weight::None,
        };
    }
    out
}

fn rect(x0: f32, y0: f32, x1: f32, y1: f32) -> Prim {
    Prim::Rect {
        x0,
        y0,
        x1,
        y1,
        alpha: 1.0,
    }
}

fn block(code: u32, w: f32, h: f32) -> Option<Vec<Prim>> {
    let (cx, cy) = (w / 2.0, h / 2.0);
    let eighth_w = w / 8.0;
    let eighth_h = h / 8.0;
    let quads = |ul: bool, ur: bool, ll: bool, lr: bool| {
        [
            (ul, rect(0.0, 0.0, cx, cy)),
            (ur, rect(cx, 0.0, w, cy)),
            (ll, rect(0.0, cy, cx, h)),
            (lr, rect(cx, cy, w, h)),
        ]
        .into_iter()
        .filter_map(|(on, r)| on.then_some(r))
        .collect()
    };
    let shade = |alpha| {
        vec![Prim::Rect {
            x0: 0.0,
            y0: 0.0,
            x1: w,
            y1: h,
            alpha,
        }]
    };
    Some(match code {
        0x2580 => vec![rect(0.0, 0.0, w, cy)],
        0x2581..=0x2587 => {
            let n = (code - 0x2580) as f32;
            vec![rect(0.0, h - eighth_h * n, w, h)]
        }
        0x2588 => vec![rect(0.0, 0.0, w, h)],
        0x2589..=0x258F => {
            let n = (0x2590 - code) as f32;
            vec![rect(0.0, 0.0, eighth_w * n, h)]
        }
        0x2590 => vec![rect(cx, 0.0, w, h)],
        0x2591 => shade(0.25),
        0x2592 => shade(0.5),
        0x2593 => shade(0.75),
        0x2594 => vec![rect(0.0, 0.0, w, eighth_h)],
        0x2595 => vec![rect(w - eighth_w, 0.0, w, h)],
        0x2596 => quads(false, false, true, false),
        0x2597 => quads(false, false, false, true),
        0x2598 => quads(true, false, false, false),
        0x2599 => quads(true, false, true, true),
        0x259A => quads(true, false, false, true),
        0x259B => quads(true, true, true, false),
        0x259C => quads(true, true, false, true),
        0x259D => quads(false, true, false, false),
        0x259E => quads(false, true, true, false),
        0x259F => quads(false, true, true, true),
        _ => return None,
    })
}

fn lines(arms: [Weight; 4], w: f32, h: f32, light: f32) -> Vec<Prim> {
    let [up, right, down, left] = arms;
    let (cx, cy) = (w / 2.0, h / 2.0);
    let thick = |weight| match weight {
        Weight::Heavy => light * 2.0,
        _ => light,
    };
    let gap = (light * 1.5).max(1.5);
    let vertical = up.max(down);
    let horizontal = left.max(right);
    let mut out = Vec::new();

    // Single and heavy arms reach past the centre far enough to cover the crossing line(s).
    let reach = |across: Weight| match across {
        Weight::None => 0.0,
        Weight::Double => gap + light / 2.0,
        other => thick(other) / 2.0,
    };
    for (weight, dir) in [(left, -1.0f32), (right, 1.0)] {
        match weight {
            Weight::None => {}
            Weight::Double => {
                for side in [-1.0f32, 1.0] {
                    let start = double_start(cx, dir, side, gap, up, down);
                    let y = cy + side * gap;
                    let (a, b) = order(start, if dir < 0.0 { 0.0 } else { w });
                    out.push(rect(a, y - light / 2.0, b, y + light / 2.0));
                }
            }
            _ => {
                let t = thick(weight);
                let start = cx - dir * reach(vertical);
                let (a, b) = order(start, if dir < 0.0 { 0.0 } else { w });
                out.push(rect(a, cy - t / 2.0, b, cy + t / 2.0));
            }
        }
    }
    for (weight, dir) in [(up, -1.0f32), (down, 1.0)] {
        match weight {
            Weight::None => {}
            Weight::Double => {
                for side in [-1.0f32, 1.0] {
                    let start = double_start(cy, dir, side, gap, left, right);
                    let x = cx + side * gap;
                    let (a, b) = order(start, if dir < 0.0 { 0.0 } else { h });
                    out.push(rect(x - light / 2.0, a, x + light / 2.0, b));
                }
            }
            _ => {
                let t = thick(weight);
                let start = cy - dir * reach(horizontal);
                let (a, b) = order(start, if dir < 0.0 { 0.0 } else { h });
                out.push(rect(cx - t / 2.0, a, cx + t / 2.0, b));
            }
        }
    }
    out
}

/// Where one line of a double arm starts, given the arms crossing it (`neg` before the centre,
/// `pos` after). Lines on the side of a double crossing arm stop at its near line (inner); the
/// others run to its far line (outer).
fn double_start(c: f32, dir: f32, side: f32, gap: f32, neg: Weight, pos: Weight) -> f32 {
    let neg_double = neg == Weight::Double;
    let pos_double = pos == Weight::Double;
    if !neg_double && !pos_double {
        return c;
    }
    let inner = c + dir * gap;
    let outer = c - dir * gap;
    match (neg_double, pos_double) {
        (true, true) => inner,
        (true, false) => {
            if side < 0.0 {
                inner
            } else {
                outer
            }
        }
        _ => {
            if side > 0.0 {
                inner
            } else {
                outer
            }
        }
    }
}

fn order(a: f32, b: f32) -> (f32, f32) {
    if a <= b { (a, b) } else { (b, a) }
}

fn dashes(horizontal: bool, t: f32, n: u8, w: f32, h: f32) -> Vec<Prim> {
    let (cx, cy) = (w / 2.0, h / 2.0);
    let len = if horizontal { w } else { h };
    let step = len / f32::from(n);
    let dash = step * 0.6;
    (0..n)
        .map(|i| {
            let a = step * f32::from(i) + (step - dash) / 2.0;
            if horizontal {
                rect(a, cy - t / 2.0, a + dash, cy + t / 2.0)
            } else {
                rect(cx - t / 2.0, a, cx + t / 2.0, a + dash)
            }
        })
        .collect()
}

fn arc(code: u32, w: f32, h: f32, light: f32) -> Prim {
    let (cx, cy) = (w / 2.0, h / 2.0);
    let r = cx.min(cy);
    // ╭ joins right and down, ╮ left and down, ╯ left and up, ╰ right and up.
    let (hx, vy) = match code {
        0x256D => (1.0, 1.0),
        0x256E => (-1.0, 1.0),
        0x256F => (-1.0, -1.0),
        _ => (1.0, -1.0),
    };
    let edge_x = if hx > 0.0 { w } else { 0.0 };
    let edge_y = if vy > 0.0 { h } else { 0.0 };
    Prim::Stroke {
        ops: vec![
            PathOp::Move(edge_x, cy),
            PathOp::Line(cx + hx * r, cy),
            PathOp::Quad {
                to: (cx, cy + vy * r),
                ctrl: (cx, cy),
            },
            PathOp::Line(cx, edge_y),
        ],
        width: light,
    }
}

fn diagonal(rising: bool, w: f32, h: f32, light: f32) -> Prim {
    let (from, to) = if rising {
        ((0.0, h), (w, 0.0))
    } else {
        ((0.0, 0.0), (w, h))
    };
    Prim::Stroke {
        ops: vec![PathOp::Move(from.0, from.1), PathOp::Line(to.0, to.1)],
        width: light,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rects(ch: char) -> Vec<(f32, f32, f32, f32)> {
        shapes(ch, 8.0, 16.0, 1.0)
            .unwrap()
            .into_iter()
            .filter_map(|p| match p {
                Prim::Rect { x0, y0, x1, y1, .. } => Some((x0, y0, x1, y1)),
                Prim::Stroke { .. } => None,
            })
            .collect()
    }

    #[test]
    fn lines_reach_the_cell_edges_so_rows_join() {
        assert_eq!(rects('─'), vec![(0.0, 7.5, 4.0, 8.5), (4.0, 7.5, 8.0, 8.5)]);
        assert_eq!(
            rects('│'),
            vec![(3.5, 0.0, 4.5, 8.0), (3.5, 8.0, 4.5, 16.0)]
        );
        let corner = rects('┌');
        assert!(corner.contains(&(3.5, 7.5, 8.0, 8.5)));
        assert!(corner.contains(&(3.5, 7.5, 4.5, 16.0)));
    }

    #[test]
    fn heavy_and_double_lines() {
        assert_eq!(rects('━')[0], (0.0, 7.0, 4.0, 9.0));
        let double = rects('═');
        assert_eq!(double.len(), 4);
        assert!(double.iter().all(|r| r.1 != 7.5));
        let corner = rects('╔');
        assert_eq!(corner.len(), 4);
    }

    #[test]
    fn blocks_fill_exact_fractions() {
        assert_eq!(rects('█'), vec![(0.0, 0.0, 8.0, 16.0)]);
        assert_eq!(rects('▀'), vec![(0.0, 0.0, 8.0, 8.0)]);
        assert_eq!(rects('▄'), vec![(0.0, 8.0, 8.0, 16.0)]);
        assert_eq!(rects('▌'), vec![(0.0, 0.0, 4.0, 16.0)]);
        assert_eq!(rects('▐'), vec![(4.0, 0.0, 8.0, 16.0)]);
        assert_eq!(rects('▛').len(), 3);
        assert_eq!(rects('▝'), vec![(4.0, 0.0, 8.0, 8.0)]);
        match &shapes('▒', 8.0, 16.0, 1.0).unwrap()[0] {
            Prim::Rect { alpha, .. } => assert_eq!(*alpha, 0.5),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn every_char_in_range_has_a_shape() {
        for code in 0x2500..=0x259F {
            let ch = char::from_u32(code).unwrap();
            assert!(is_procedural(ch));
            assert!(
                shapes(ch, 8.0, 16.0, 1.0).is_some_and(|s| !s.is_empty()),
                "{ch}"
            );
        }
        assert!(!is_procedural('a'));
    }

    #[test]
    fn rounded_corners_are_strokes_to_the_edges() {
        let shapes = shapes('╭', 8.0, 16.0, 1.0).unwrap();
        let [Prim::Stroke { ops, .. }] = shapes.as_slice() else {
            panic!("{shapes:?}");
        };
        assert_eq!(ops.first(), Some(&PathOp::Move(8.0, 8.0)));
        assert_eq!(ops.last(), Some(&PathOp::Line(4.0, 16.0)));
    }
}
