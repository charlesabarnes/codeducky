//! Repo tasks, run as `cargo xtask <task>`.

mod ghostty;

use std::path::PathBuf;

use anyhow::bail;

const USAGE: &str = "usage: cargo xtask <task>

tasks:
  fetch-ghostty   download the libghostty-vt prebuilt into .toolchain/";

fn main() -> anyhow::Result<()> {
    let task = std::env::args().nth(1);
    match task.as_deref() {
        Some("fetch-ghostty") => ghostty::fetch(&repo_root()),
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
