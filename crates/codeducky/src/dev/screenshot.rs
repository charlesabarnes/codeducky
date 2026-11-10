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

/// Draws the window every 100 ms for the rest of the run: with the screen locked the display
/// link does not tick, and views that act on layout (a terminal attaches once it knows its grid)
/// would otherwise wait for the capture.
pub fn pump_frames(cx: &mut App) {
    cx.spawn(async move |cx| {
        loop {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(100))
                .await;
            let window = cx.update(|cx| cx.windows().first().copied());
            let Some(window) = window else {
                return;
            };
            window
                .update(cx, |_, window, cx| {
                    window.draw(cx).clear(cx);
                })
                .ok();
        }
    })
    .detach();
}
