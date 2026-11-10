//! Renders the window through GPUI's test-support renderer: no Screen Recording permission
//! needed, and it works while the screen is locked.

use std::path::Path;

use anyhow::Context as _;
use gpui_kit::*;

pub fn capture(path: &Path, cx: &mut App) -> anyhow::Result<()> {
    let window = *cx.windows().first().context("no window is open")?;
    window.update(cx, |_, window, cx| {
        // The display link does not tick while the screen is locked, so draw explicitly; views
        // that measure on paint (the diff's row width) need a second pass.
        for _ in 0..3 {
            window.draw(cx).clear(cx);
        }
        window.render_to_image()?.save(path)?;
        anyhow::Ok(())
    })?
}
