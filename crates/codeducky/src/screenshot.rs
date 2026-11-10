//! `--screenshot <path>`: renders the main window to a PNG through GPUI's
//! test-support renderer, then quits. Needs no Screen Recording permission
//! and works while the screen is locked.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context as _;
use gpui_kit::*;

const SETTLE: Duration = Duration::from_millis(500);

pub fn path_from_args() -> Option<PathBuf> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--screenshot" {
            return args.next().map(PathBuf::from);
        }
    }
    None
}

pub fn capture_then_quit(path: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        cx.background_executor().timer(SETTLE).await;
        cx.update(|cx| {
            match capture(&path, cx) {
                Ok(()) => eprintln!("screenshot saved to {}", path.display()),
                Err(err) => {
                    eprintln!("screenshot failed: {err:#}");
                    std::process::exit(1);
                }
            }
            cx.quit();
        })
    })
    .detach();
}

fn capture(path: &Path, cx: &mut App) -> anyhow::Result<()> {
    let window = *cx.windows().first().context("no window is open")?;
    window.update(cx, |_, window, cx| {
        // The display link does not tick while the screen is locked, so draw explicitly.
        window.draw(cx).clear(cx);
        window.render_to_image()?.save(path)?;
        anyhow::Ok(())
    })?
}
