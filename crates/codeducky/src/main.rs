//! Code Ducky: a native code review app on herdr-core.

mod app;
#[cfg(feature = "screenshot")]
mod screenshot;
mod theme;
mod workspace;

fn main() {
    app::run();
}
