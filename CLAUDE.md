# Code Ducky

Native review app: Rust, GPUI via gpui-kit, libghostty-vt for terminals, on top of herdr-core (`hc`).
The plan, decisions and phases live in `~/.claude/plans/codeducky-native.md`.

## Commands

```sh
export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"
cargo xtask fetch-ghostty                             # once; macOS libghostty-vt prebuilt
cargo run -p codeducky                                # the app
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo run -p codeducky --features screenshot -- --screenshot /tmp/codeducky.png
```

`--screenshot` renders the window through GPUI's test-support renderer and quits. Use it to see the
UI when the screen is locked or there is no Screen Recording permission. It is dev only, behind the
`screenshot` feature.

## Crates

| Crate | What it holds |
|---|---|
| `crates/codeducky` | The GPUI app binary: windows, views, keymap |
| `crates/ducky-review` | Review domain logic: notes, anchors, review session. No IO |
| `crates/ducky-host` | The `Host` trait (exec, read, write on one machine) and `LocalHost` |
| `crates/ducky-hc` | herdr-core JSON-RPC client; implements `Host` per machine |
| `crates/ducky-git` | The git CLI over `Host`, diff parsing |
| `crates/ducky-notes` | Notes and review state files over `Host` |
| `crates/ducky-github` | GitHub inbox, PR diffs, threads, CI |
| `crates/ducky-terminal` | hc attach stream, libghostty-vt, GPUI cell renderer |
| `xtask` | `cargo xtask fetch-ghostty` |

Pins: `gpui-kit =0.9.1` (GPUI as `gpui-pre =0.3.12`); `libghostty-vt` from git
`Uzaaft/libghostty-rs` rev `768add9` with `pkg-config`, against Ghostty `vt-1.0.0`.

## House rules

- Keep services and UI modular: small modules with one job, domain logic out of views.
- No comments that restate the code. Comment only the non-obvious why.
- Do not decide architecture alone. Raise it, with a recommendation, and update the plan.
- Never touch the user's live herdr-core terminals or session. Tests that need `hc` use their own
  `HC_SESSION` and scratch `XDG_*` dirs.
- Never run Docker locally.
