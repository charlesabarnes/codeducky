//! Repo tasks, run as `cargo xtask <task>`.

mod bundle;
mod ghostty;
mod icons;

use std::path::PathBuf;

use anyhow::bail;

const USAGE: &str = "usage: cargo xtask <task>

tasks:
  fetch-ghostty   install libghostty-vt into .toolchain/ (macOS prebuilt, Linux built with Zig)
  icons           render assets/icons/*.png from assets/codeducky.svg
  bundle          macOS: build `Code Ducky.app` and a zip under target/release/bundle/

The Flatpak is built by packaging/flatpak/build.sh on Linux.";

fn main() -> anyhow::Result<()> {
    let root = repo_root();
    match std::env::args().nth(1).as_deref() {
        Some("fetch-ghostty") => ghostty::fetch(&root),
        Some("icons") => icons::generate(&root),
        Some("bundle") => bundle::run(&root),
        Some("-h" | "--help") => {
            println!("{USAGE}");
            Ok(())
        }
        _ => bail!("{USAGE}"),
    }
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask lives one level below the repo root")
        .to_path_buf()
}
