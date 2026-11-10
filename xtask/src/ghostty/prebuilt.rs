//! macOS: the static library slice of the official XCFramework.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use anyhow::{bail, ensure};

use super::{ReleaseFile, VERSION};

const XCFRAMEWORK: ReleaseFile = ReleaseFile {
    name: "ghostty-vt-1.0.0.xcframework.zip",
    sha256: "2c32b7409b2b6c2ef6cfd606526de357762ad458bdc27134ad074e86506a8bc2",
};
const SLICE: &str = "ghostty-vt.xcframework/macos-arm64_x86_64/";

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

pub fn install(toolchain: &Path) -> anyhow::Result<()> {
    let dest = super::install_dir(toolchain);
    if super::is_current(&dest, XCFRAMEWORK.sha256) {
        println!("libghostty-vt {VERSION} is already in {}", dest.display());
        return Ok(());
    }

    let archive = super::download_verified(&XCFRAMEWORK, &toolchain.join("downloads"))?;
    let staging = toolchain.join(format!(".libghostty-vt-{VERSION}.partial"));
    super::remove_dir_if_exists(&staging)?;
    extract_slice(&fs::read(archive)?, &staging)?;
    let pkgconfig = staging.join("lib/pkgconfig");
    fs::create_dir_all(&pkgconfig)?;
    fs::write(pkgconfig.join("libghostty-vt-static.pc"), PC_FILE)?;
    super::write_stamp(&staging, XCFRAMEWORK.sha256)?;

    super::replace_dir(&staging, &dest)?;
    println!("installed libghostty-vt {VERSION} into {}", dest.display());
    Ok(())
}

/// Copies `<slice>libghostty-vt.a` to `lib/` and `<slice>Headers/` to `include/`.
fn extract_slice(archive: &[u8], dest: &Path) -> anyhow::Result<()> {
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
        let Some(rel) = name.to_str().and_then(|n| n.strip_prefix(SLICE)) else {
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
        "{SLICE}libghostty-vt.a is missing from the archive"
    );
    Ok(())
}
