//! Linux: builds the official source tarball with Zig 0.17, following
//! Ghostty's PACKAGING-LIBGHOSTTY.md. `--system` points Zig at the unpacked
//! dependency tarball, so nothing is fetched during the build. Only the static
//! library is kept, like the macOS prebuilt.

use std::fs;
use std::path::Path;
use std::process::Command;

use anyhow::{Context, ensure};

use super::{ReleaseFile, VERSION};

const SOURCE: ReleaseFile = ReleaseFile {
    name: "libghostty-vt-1.0.0.tar.gz",
    sha256: "4a6ef758be721923e1969e7b81b443dcc92d8dd3fb5a39600c03a8817a753676",
};
const DEPS: ReleaseFile = ReleaseFile {
    name: "libghostty-vt-1.0.0-deps.tar.gz",
    sha256: "4d5ea5e448e4c7ea8fb55ccbaa8668f2a97d44f438cee831e2b7ecd162d85c29",
};
/// `minimum_zig_version` in the tarball's build.zig.zon; any 0.17.x builds it.
const ZIG_SERIES: &str = "0.17.";

pub fn build(toolchain: &Path) -> anyhow::Result<()> {
    let toolchain = std::path::absolute(toolchain)?;
    let zig = std::env::var("ZIG").unwrap_or_else(|_| "zig".into());
    let zig_version = zig_version(&zig)?;
    let stamp = format!("{} {} zig-{zig_version}", SOURCE.sha256, DEPS.sha256);
    let dest = super::install_dir(&toolchain);
    if super::is_current(&dest, &stamp) {
        println!("libghostty-vt {VERSION} is already in {}", dest.display());
        return Ok(());
    }

    let downloads = toolchain.join("downloads");
    let source = super::download_verified(&SOURCE, &downloads)?;
    let deps = super::download_verified(&DEPS, &downloads)?;

    let work = toolchain.join(format!(".libghostty-vt-{VERSION}.build"));
    super::remove_dir_if_exists(&work)?;
    fs::create_dir_all(&work)?;
    untar(&source, &work)?;
    untar(&deps, &work)?;

    let staging = toolchain.join(format!(".libghostty-vt-{VERSION}.partial"));
    super::remove_dir_if_exists(&staging)?;
    println!("building libghostty-vt {VERSION} with zig {zig_version}");
    run(Command::new(&zig)
        .arg("build")
        .arg("--prefix")
        .arg(&staging)
        .arg("--system")
        .arg(work.join(format!("libghostty-vt-{VERSION}-deps")))
        .arg("--cache-dir")
        .arg(work.join("zig-cache"))
        .args(["-Doptimize=ReleaseFast", "-Dcpu=baseline"])
        // Must start empty; a cache holding package archives can crash Zig 0.17.
        .env("ZIG_GLOBAL_CACHE_DIR", work.join("zig-global-cache"))
        .current_dir(work.join(format!("libghostty-vt-{VERSION}"))))?;

    keep_static_only(&staging)?;
    relocate_pkgconfig(&staging)?;
    super::write_stamp(&staging, &stamp)?;
    super::replace_dir(&staging, &dest)?;
    super::remove_dir_if_exists(&work)?;
    println!("installed libghostty-vt {VERSION} into {}", dest.display());
    Ok(())
}

fn zig_version(zig: &str) -> anyhow::Result<String> {
    let output = Command::new(zig)
        .arg("version")
        .output()
        .with_context(|| format!("running `{zig} version`; install Zig 0.17 or set ZIG"))?;
    ensure!(output.status.success(), "`{zig} version` failed");
    let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    ensure!(
        version.starts_with(ZIG_SERIES),
        "libghostty-vt {VERSION} needs Zig {ZIG_SERIES}x, found {version}"
    );
    Ok(version)
}

fn untar(archive: &Path, into: &Path) -> anyhow::Result<()> {
    run(Command::new("tar")
        .arg("-xzf")
        .arg(archive)
        .arg("-C")
        .arg(into))
}

fn run(command: &mut Command) -> anyhow::Result<()> {
    let status = command
        .status()
        .with_context(|| format!("running {command:?}"))?;
    ensure!(status.success(), "{command:?} failed with {status}");
    Ok(())
}

/// libghostty-vt-sys asks for `libghostty-vt-static`; dropping the shared
/// library keeps the binary free of a runtime dependency on it.
fn keep_static_only(prefix: &Path) -> anyhow::Result<()> {
    let lib = prefix.join("lib");
    ensure!(
        lib.join("libghostty-vt.a").is_file(),
        "zig build did not install lib/libghostty-vt.a"
    );
    for entry in fs::read_dir(&lib)? {
        let path = entry?.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with("libghostty-vt.so") {
            fs::remove_file(&path)?;
        }
    }
    let shared_pc = lib.join("pkgconfig/libghostty-vt.pc");
    if shared_pc.exists() {
        fs::remove_file(shared_pc)?;
    }
    Ok(())
}

/// Zig writes the absolute install prefix into the .pc file; make it relative
/// to the file so the directory can be moved into place (and around).
fn relocate_pkgconfig(prefix: &Path) -> anyhow::Result<()> {
    let pc = prefix.join("lib/pkgconfig/libghostty-vt-static.pc");
    let text = fs::read_to_string(&pc).with_context(|| format!("reading {}", pc.display()))?;
    let absolute = prefix.to_str().context("non-UTF-8 toolchain path")?;
    fs::write(&pc, text.replace(absolute, "${pcfiledir}/../.."))?;
    Ok(())
}
