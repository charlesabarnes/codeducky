//! Code Ducky: a native code review app on herdr-core.

mod app;
mod config;
#[cfg(feature = "screenshot")]
mod dev;
mod keymap;
mod state;
mod theme;
mod views;

fn main() {
    app::run();
}
