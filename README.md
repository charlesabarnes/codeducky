# Code Ducky

A native code review app for your own branches and the pull requests you are asked to review. It is
written in Rust on [GPUI](https://www.gpui.rs) (through gpui-kit), renders terminals with
[libghostty-vt](https://ghostty.org), and is built on herdr-core (`hc`), which supplies machines,
remote commands and files, persistent terminals and agents. Code Ducky supplies diffs, notes and the
review flow.

## Build

Needs Rust (pinned by `rust-toolchain.toml`) and `pkg-config`. On macOS:

```sh
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"
cargo xtask fetch-ghostty   # official libghostty-vt prebuilt into .toolchain/, sha256-checked
cargo run -p codeducky
```

On Linux there is no libghostty-vt prebuilt: install Zig 0.17 and skip `fetch-ghostty`; the build
compiles Ghostty from source. See `.github/workflows/ci.yml` for the system packages GPUI needs.
