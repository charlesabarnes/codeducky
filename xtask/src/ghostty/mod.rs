//! Installs libghostty-vt into `.toolchain/libghostty-vt-<version>/` with a
//! `lib/pkgconfig/libghostty-vt-static.pc`, so libghostty-vt-sys links it
//! instead of cloning and building Ghostty itself. `.cargo/config.toml` points
//! PKG_CONFIG_PATH there.
//!
//! macOS uses the official prebuilt XCFramework. Linux has no prebuilt, so it
//! builds the official source tarball with Zig, offline, against the official
//! dependency tarball.

mod prebuilt;
mod source;

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use anyhow::{Context, bail, ensure};
use sha2::{Digest, Sha256};

const VERSION: &str = "1.0.0";
const BASE_URL: &str = "https://release.files.ghostty.org/libghostty-vt";

/// A release file and its checksum from the published `SHA256SUMS`.
struct ReleaseFile {
    name: &'static str,
    sha256: &'static str,
}

pub fn fetch(root: &Path) -> anyhow::Result<()> {
    let toolchain = root.join(".toolchain");
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64" | "x86_64") => prebuilt::install(&toolchain),
        ("linux", "x86_64" | "aarch64") => source::build(&toolchain),
        (os, arch) => bail!("no libghostty-vt {VERSION} recipe for {os}/{arch}"),
    }
}

fn install_dir(toolchain: &Path) -> PathBuf {
    toolchain.join(format!("libghostty-vt-{VERSION}"))
}

/// True when `dest` was installed from exactly these inputs.
fn is_current(dest: &Path, stamp: &str) -> bool {
    fs::read_to_string(dest.join(".sha256")).is_ok_and(|s| s.trim() == stamp)
}

fn write_stamp(dest: &Path, stamp: &str) -> anyhow::Result<()> {
    Ok(fs::write(dest.join(".sha256"), format!("{stamp}\n"))?)
}

/// Downloads a release file, or reuses a verified copy in `cache`.
fn download_verified(file: &ReleaseFile, cache: &Path) -> anyhow::Result<PathBuf> {
    let path = cache.join(file.name);
    if fs::read(&path).is_ok_and(|bytes| sha256_hex(&bytes) == file.sha256) {
        return Ok(path);
    }
    let url = format!("{BASE_URL}/{VERSION}/{}", file.name);
    println!("downloading {url}");
    let bytes = download(&url)?;
    let actual = sha256_hex(&bytes);
    ensure!(
        actual == file.sha256,
        "sha256 mismatch for {}: expected {}, got {actual}",
        file.name,
        file.sha256
    );
    fs::create_dir_all(cache)?;
    fs::write(&path, bytes)?;
    Ok(path)
}

fn download(url: &str) -> anyhow::Result<Vec<u8>> {
    let mut body = Vec::new();
    ureq::get(url)
        .call()
        .with_context(|| format!("GET {url}"))?
        .into_body()
        .into_reader()
        .read_to_end(&mut body)
        .with_context(|| format!("reading {url}"))?;
    Ok(body)
}

fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Swaps `staging` into `dest`, keeping the window without a library short.
fn replace_dir(staging: &Path, dest: &Path) -> anyhow::Result<()> {
    let old = dest.with_extension("old");
    remove_dir_if_exists(&old)?;
    if dest.exists() {
        fs::rename(dest, &old)?;
    }
    fs::rename(staging, dest)?;
    remove_dir_if_exists(&old)
}

fn remove_dir_if_exists(dir: &Path) -> anyhow::Result<()> {
    match fs::remove_dir_all(dir) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}
