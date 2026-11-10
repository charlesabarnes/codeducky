#!/usr/bin/env bash
# Builds the Code Ducky Flatpak and a single-file bundle, on Linux x86_64.
# Needs: flatpak, flatpak-builder, git, curl, python3 with aiohttp, tomlkit and PyYAML.
# Output: target/flatpak/codeducky.flatpak (override the folder with FLATPAK_BUILD_DIR).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
app_id=io.github.charlesabarnes.CodeDucky
build=${FLATPAK_BUILD_DIR:-$root/target/flatpak}
flathub=https://dl.flathub.org/repo/flathub.flatpakrepo
# flatpak-builder-tools, pinned: its cargo generator turns Cargo.lock into offline sources.
generator_rev=9d86d336a39b9af38b86f114b6ce5820fe260f91

mkdir -p "$build"
generator=$build/flatpak-cargo-generator.py
if [ ! -f "$generator" ]; then
  curl -fsSL -o "$generator" \
    "https://raw.githubusercontent.com/flatpak/flatpak-builder-tools/$generator_rev/cargo/flatpak-cargo-generator.py"
fi
python3 "$generator" "$root/Cargo.lock" -o "$here/cargo-sources.json"

flatpak remote-add "${FLATPAK_INSTALLATION:---user}" --if-not-exists flathub "$flathub"
flatpak-builder "${FLATPAK_INSTALLATION:---user}" --install-deps-from=flathub --force-clean --disable-rofiles-fuse \
  --state-dir="$build/state" --repo="$build/repo" "$build/app" "$here/$app_id.yml"
flatpak build-bundle --runtime-repo="$flathub" "$build/repo" "$build/codeducky.flatpak" "$app_id"
echo "$build/codeducky.flatpak"
