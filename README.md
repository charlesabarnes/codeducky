# Code Ducky

A native code review app for your own branches and the pull requests you are asked to review. It is
written in Rust on [GPUI](https://www.gpui.rs) (through gpui-kit), renders terminals with
[libghostty-vt](https://ghostty.org), and is built on herdr-core (`hc`), which supplies machines,
remote commands and files, persistent terminals and agents. Code Ducky supplies diffs, notes and the
review flow.

## herdr-core

Code Ducky expects [herdr-core](https://herdr.dev) 0.1.19 or newer running on the machine it runs on
(`hc server status` starts it). It finds the core's socket the way `hc` does: `HC_SOCKET`, then
`socket = "..."` in `~/.config/herdr-core/config.toml`, then `$XDG_RUNTIME_DIR/herdr-core/`, then
`~/.local/state/herdr-core/<session>/`. Without a core it still reviews local repositories, running
`git` itself, but agents, terminals and other machines are unavailable.

## Build

Needs Rust (pinned by `rust-toolchain.toml`) and `pkg-config`.

```sh
cargo xtask fetch-ghostty   # once: libghostty-vt into .toolchain/
cargo run -p codeducky
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`fetch-ghostty` installs libghostty-vt 1.0.0 with a pkg-config file, and libghostty-vt-sys links it
from there (`.cargo/config.toml` sets `PKG_CONFIG_PATH`):

- **macOS**: the official prebuilt XCFramework, sha256-checked.
- **Linux**: there is no prebuilt, so it downloads the official source and dependency tarballs
  (sha256-pinned from the release's `SHA256SUMS`) and builds them offline with Zig 0.17
  (`zig` on `PATH`, or set `ZIG`). Takes a few minutes, once.

Linux also needs GPUI's system libraries. On Ubuntu 24.04:

```sh
sudo apt-get install gcc g++ clang pkg-config libfontconfig-dev libwayland-dev \
  libxkbcommon-dev libxkbcommon-x11-dev libx11-dev libx11-xcb-dev libxcb1-dev \
  libssl-dev libzstd-dev libasound2-dev libvulkan-dev
```

Tests that need a real herdr-core are opt-in; they start their own scratch core with its own session
and XDG folders, never the live one:

```sh
cargo test -p ducky-hc --features scratch --test scratch_core -- --ignored
cargo test -p ducky-agents -- --ignored
```

## Package

### macOS

```sh
cargo xtask bundle
```

Builds a release binary and writes `target/release/bundle/Code Ducky.app` (bundle id
`io.github.charlesabarnes.CodeDucky`, version from `Cargo.toml`, icon from `assets/icons/`) and
`CodeDucky-<version>-macos-<arch>.zip`. The app is ad-hoc signed, not notarised, so on another Mac
Gatekeeper blocks the first launch: right-click, Open, or
`xattr -dr com.apple.quarantine "Code Ducky.app"`.

The icons in `assets/icons/` are rendered from the pixel-art `assets/codeducky.svg` with
nearest-neighbour scaling; run `cargo xtask icons` after changing the SVG.

### Linux (Flatpak, x86_64)

```sh
packaging/flatpak/build.sh   # writes target/flatpak/codeducky.flatpak
flatpak install --user target/flatpak/codeducky.flatpak
flatpak run io.github.charlesabarnes.CodeDucky
```

Needs `flatpak`, `flatpak-builder`, and Python 3 with `aiohttp`, `tomlkit` and `PyYAML` (for
flatpak-cargo-generator, which turns `Cargo.lock` into offline sources). The build itself is offline:
Rust 1.99.1, Zig 0.17.1 and the libghostty-vt tarballs are pinned, checksummed sources in
`packaging/flatpak/io.github.charlesabarnes.CodeDucky.yml`, and none of them end up in the app.
The runtime is `org.freedesktop.Platform` 26.08 from Flathub.

What the sandbox allows:

- Wayland, with X11 as a fallback, and the GPU (`--device=dri`).
- The network, for GitHub's API.
- The herdr-core socket: `xdg-run/herdr-core`, `~/.local/state/herdr-core` (the fallback socket
  place) and `~/.config/herdr-core` read-only (for a `socket = ...` override).

Nothing else of the host. Git, files, terminals, agents and other machines all go through
herdr-core, which runs outside the sandbox, so the Flatpak needs no home-folder access and no
`flatpak-spawn`. That also means:

- **herdr-core must be running** before the app starts; the app cannot start it from inside the
  sandbox. Without it the app falls back to running `git` inside the sandbox, which the Freedesktop
  runtime is not expected to provide, so treat a running core as required.
- `HC_SOCKET` and `HC_SESSION` from your shell do not reach the app. Use
  `flatpak override --user --env=HC_SESSION=... io.github.charlesabarnes.CodeDucky`, or a `socket`
  line in `~/.config/herdr-core/config.toml`; a socket outside the folders above also needs a
  `--filesystem` override.
- The GitHub token comes from `gh auth token` run on the app's own machine through herdr-core
  (`machine.exec`), so a `gh` login on the host works; a token entered in the app is the fallback.

### Releases

`.github/workflows/release.yml` runs on a `v*` tag: it builds the macOS zip and the Flatpak bundle
and attaches both to a draft GitHub release.
