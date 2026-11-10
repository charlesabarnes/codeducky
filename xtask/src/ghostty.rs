//! Installs the official libghostty-vt prebuilt into `.toolchain/` with a
//! pkg-config file, so libghostty-vt-sys links it instead of building Ghostty
//! from source with Zig. `.cargo/config.toml` points PKG_CONFIG_PATH here.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use anyhow::{Context, bail, ensure};
use sha2::{Digest, Sha256};

const VERSION: &str = "1.0.0";
const BASE_URL: &str = "https://release.files.ghostty.org/libghostty-vt";

/// A release archive and the static library slice inside it.
struct Prebuilt {
    file: &'static str,
    sha256: &'static str,
    slice: &'static str,
}

/// Published in `SHA256SUMS` next to the archive.
const MACOS: Prebuilt = Prebuilt {
    file: "ghostty-vt-1.0.0.xcframework.zip",
    sha256: "2c32b7409b2b6c2ef6cfd606526de357762ad458bdc27134ad074e86506a8bc2",
    slice: "ghostty-vt.xcframework/macos-arm64_x86_64/",
};

const PC_FILE: &str = "\
prefix=${pcfiledir}/../..
libdir=${prefix}/lib
includedir=${prefix}/include

Name: libghostty-vt-static
Description: Ghostty VT library (static)
Version: 1.0.0
Libs: -L${libdir} -lghostty-vt
Cflags: -I${includedir}
";

pub fn fetch(root: &Path) -> anyhow::Result<()> {
    let prebuilt = prebuilt_for_host()?;
    let toolchain = root.join(".toolchain");
    let dest = toolchain.join(format!("libghostty-vt-{VERSION}"));
    let stamp = dest.join(".sha256");
    if fs::read_to_string(&stamp).is_ok_and(|s| s.trim() == prebuilt.sha256) {
        println!("libghostty-vt {VERSION} is already in {}", dest.display());
        return Ok(());
    }

    let url = format!("{BASE_URL}/{VERSION}/{}", prebuilt.file);
    println!("downloading {url}");
    let archive = download(&url)?;
    let actual = sha256_hex(&archive);
    ensure!(
        actual == prebuilt.sha256,
        "sha256 mismatch for {}: expected {}, got {actual}",
        prebuilt.file,
        prebuilt.sha256
    );

    fs::create_dir_all(&toolchain)?;
    let staging = toolchain.join(format!(".libghostty-vt-{VERSION}.partial"));
    remove_dir_if_exists(&staging)?;
    extract_slice(&archive, prebuilt.slice, &staging)?;
    let pkgconfig = staging.join("lib/pkgconfig");
    fs::create_dir_all(&pkgconfig)?;
    fs::write(pkgconfig.join("libghostty-vt-static.pc"), PC_FILE)?;
    fs::write(staging.join(".sha256"), format!("{}\n", prebuilt.sha256))?;

    let old = toolchain.join(format!(".libghostty-vt-{VERSION}.old"));
    replace_dir(&staging, &dest, &old)?;
    println!("installed libghostty-vt {VERSION} into {}", dest.display());
    Ok(())
}

fn prebuilt_for_host() -> anyhow::Result<Prebuilt> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64" | "x86_64") => Ok(MACOS),
        ("linux", _) => bail!(
            "libghostty-vt {VERSION} publishes no Linux prebuilt, only the source tarball.\n\
             Build it from source instead: install Zig 0.17 and build without running this task;\n\
             libghostty-vt-sys then builds Ghostty itself when pkg-config finds no library."
        ),
        (os, arch) => bail!("no libghostty-vt {VERSION} prebuilt for {os}/{arch}"),
    }
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

/// Copies `<slice>libghostty-vt.a` to `lib/` and `<slice>Headers/` to `include/`.
fn extract_slice(archive: &[u8], slice: &str, dest: &Path) -> anyhow::Result<()> {
    let mut zip = zip::ZipArchive::new(io::Cursor::new(archive))?;
    let mut found_lib = false;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        if entry.is_dir() {
            continue;
        }
        let Some(name) = entry.enclosed_name() else {
            bail!("unsafe path in archive entry {i}");
        };
        let Some(rel) = name.to_str().and_then(|n| n.strip_prefix(slice)) else {
            continue;
        };
        let target: PathBuf = if rel == "libghostty-vt.a" {
            found_lib = true;
            dest.join("lib").join(rel)
        } else if let Some(header) = rel.strip_prefix("Headers/") {
            dest.join("include").join(header)
        } else {
            continue;
        };
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        io::copy(&mut entry, &mut fs::File::create(&target)?)?;
    }
    ensure!(
        found_lib,
        "{slice}libghostty-vt.a is missing from the archive"
    );
    Ok(())
}

/// Swaps `staging` into `dest`, keeping the window without a library short.
fn replace_dir(staging: &Path, dest: &Path, old: &Path) -> anyhow::Result<()> {
    remove_dir_if_exists(old)?;
    if dest.exists() {
        fs::rename(dest, old)?;
    }
    fs::rename(staging, dest)?;
    remove_dir_if_exists(old)
}

fn remove_dir_if_exists(dir: &Path) -> anyhow::Result<()> {
    match fs::remove_dir_all(dir) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}
