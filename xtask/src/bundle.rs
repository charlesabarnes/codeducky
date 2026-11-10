//! `Code Ducky.app` for macOS: release binary, Info.plist, .icns, ad-hoc
//! signature, and a zip for a release.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, ensure};

use crate::icons;

pub const BUNDLE_ID: &str = "io.github.charlesabarnes.CodeDucky";
const NAME: &str = "Code Ducky";
const EXECUTABLE: &str = "codeducky";
const VERSION: &str = env!("CARGO_PKG_VERSION");
/// GPUI's Metal renderer and the APIs it uses need macOS 11.
const MIN_MACOS: &str = "11.0";

pub fn run(root: &Path) -> anyhow::Result<()> {
    ensure!(
        cfg!(target_os = "macos"),
        "`cargo xtask bundle` builds a macOS .app; on Linux use `cargo xtask flatpak`"
    );
    run_tool(
        Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
            .args(["build", "--release", "--locked", "-p", "codeducky"])
            .current_dir(root),
    )?;

    let release = target_dir(root).join("release");
    let out = release.join("bundle");
    let app = out.join(format!("{NAME}.app"));
    if app.exists() {
        fs::remove_dir_all(&app)?;
    }
    let contents = app.join("Contents");
    fs::create_dir_all(contents.join("MacOS"))?;
    fs::create_dir_all(contents.join("Resources"))?;
    fs::copy(
        release.join(EXECUTABLE),
        contents.join("MacOS").join(EXECUTABLE),
    )?;
    fs::write(contents.join("Info.plist"), info_plist())?;
    fs::write(contents.join("PkgInfo"), "APPL????")?;
    icns(root, &out, &contents.join("Resources/codeducky.icns"))?;

    run_tool(
        Command::new("codesign")
            .args(["--force", "--sign", "-", "--timestamp=none"])
            .arg(&app),
    )?;
    run_tool(
        Command::new("codesign")
            .args(["--verify", "--strict"])
            .arg(&app),
    )?;

    let zip = out.join(format!(
        "CodeDucky-{VERSION}-macos-{}.zip",
        std::env::consts::ARCH
    ));
    if zip.exists() {
        fs::remove_file(&zip)?;
    }
    // ditto keeps the signature's extended attributes and symlinks intact.
    run_tool(
        Command::new("ditto")
            .args(["-c", "-k", "--keepParent"])
            .arg(&app)
            .arg(&zip),
    )?;
    println!("{}\n{}", app.display(), zip.display());
    Ok(())
}

fn target_dir(root: &Path) -> PathBuf {
    std::env::var_os("CARGO_TARGET_DIR").map_or_else(|| root.join("target"), PathBuf::from)
}

fn info_plist() -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleDisplayName</key>
	<string>{NAME}</string>
	<key>CFBundleExecutable</key>
	<string>{EXECUTABLE}</string>
	<key>CFBundleIconFile</key>
	<string>codeducky</string>
	<key>CFBundleIdentifier</key>
	<string>{BUNDLE_ID}</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>{NAME}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>{VERSION}</string>
	<key>CFBundleVersion</key>
	<string>{VERSION}</string>
	<key>LSApplicationCategoryType</key>
	<string>public.app-category.developer-tools</string>
	<key>LSMinimumSystemVersion</key>
	<string>{MIN_MACOS}</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSSupportsAutomaticGraphicsSwitching</key>
	<true/>
</dict>
</plist>
"#
    )
}

/// iconutil wants `icon_<n>x<n>[@2x].png` in a `.iconset` folder.
fn icns(root: &Path, scratch: &Path, dest: &Path) -> anyhow::Result<()> {
    let iconset = scratch.join("codeducky.iconset");
    if iconset.exists() {
        fs::remove_dir_all(&iconset)?;
    }
    fs::create_dir_all(&iconset)?;
    for base in [16, 32, 128, 256, 512] {
        fs::copy(
            icons::png(root, base)?,
            iconset.join(format!("icon_{base}x{base}.png")),
        )?;
        fs::copy(
            icons::png(root, base * 2)?,
            iconset.join(format!("icon_{base}x{base}@2x.png")),
        )?;
    }
    run_tool(
        Command::new("iconutil")
            .args(["-c", "icns", "-o"])
            .arg(dest)
            .arg(&iconset),
    )?;
    fs::remove_dir_all(&iconset)?;
    Ok(())
}

fn run_tool(command: &mut Command) -> anyhow::Result<()> {
    let status = command
        .status()
        .with_context(|| format!("running {command:?}"))?;
    ensure!(status.success(), "{command:?} failed with {status}");
    Ok(())
}
