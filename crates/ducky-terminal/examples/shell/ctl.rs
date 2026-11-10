//! Dev-only control socket so the demo can be driven without Accessibility or Screen Recording
//! permissions (and with the screen locked). Events go through GPUI's normal window dispatch;
//! screenshots come from the test-support renderer.
//!
//! `printf 'type ls\nenter\nshot /tmp/a.png\n' | nc -U /tmp/ducky-terminal.sock`
//!
//! Commands: `key <spec>...`, `type <text>`, `enter`, `paste <text>`, `scroll <dy>`,
//! `resize <w> <h>`, `theme light|dark`, `drag <c0> <r0> <c1> <r1>` (cells),
//! `click <col> <row> <count>`, `hover <col> <row> [1 to click]` (with cmd/ctrl held),
//! `preedit <text>` / `commit <text>` (IME), `copy <path>` (selection via the Copy action, clipboard restored),
//! `dump <path>` (visible text), `shot <path>`.

use std::io::{BufRead, BufReader};
use std::os::unix::net::UnixListener;

use anyhow::{Context as _, bail};
use ducky_terminal::TerminalView;
use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::*;

use crate::Shell;

pub const SOCKET: &str = "/tmp/ducky-terminal.sock";

pub fn start(shell: Entity<Shell>, window: &mut Window, cx: &mut App) {
    let _ = std::fs::remove_file(SOCKET);
    let (tx, rx) = flume::unbounded::<String>();
    std::thread::spawn(move || {
        let Ok(listener) = UnixListener::bind(SOCKET) else {
            eprintln!("ctl: cannot bind {SOCKET}");
            return;
        };
        for stream in listener.incoming().flatten() {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        }
    });
    window
        .spawn(cx, async move |cx| {
            while let Ok(line) = rx.recv_async().await {
                let shell = shell.clone();
                let result = cx.update(|window, cx| {
                    // The display link does not tick while the screen is locked.
                    window.draw(cx).clear(cx);
                    run(&line, &shell, window, cx)
                });
                match result {
                    Ok(Err(e)) => eprintln!("ctl {line:?}: {e:#}"),
                    Err(_) => return,
                    Ok(Ok(())) => {}
                }
            }
        })
        .detach();
}

fn terminal(shell: &Entity<Shell>, cx: &App) -> Entity<TerminalView> {
    shell.read(cx).terminal().clone()
}

fn run(line: &str, shell: &Entity<Shell>, window: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    let (cmd, arg) = line.split_once(' ').unwrap_or((line, ""));
    let nums = || -> anyhow::Result<Vec<f32>> {
        arg.split_whitespace()
            .map(|s| s.parse::<f32>().context("number"))
            .collect()
    };
    match cmd {
        "key" => {
            for spec in arg.split_whitespace() {
                let spec: &'static str = Box::leak(spec.to_owned().into_boxed_str());
                window.dispatch_keystroke(Keystroke::parse(spec)?, cx);
            }
        }
        "type" => {
            for ch in arg.chars() {
                let key = match ch {
                    ' ' => "space".to_owned(),
                    c => c.to_lowercase().to_string(),
                };
                let keystroke = Keystroke {
                    modifiers: Modifiers {
                        shift: ch.is_uppercase(),
                        ..Default::default()
                    },
                    key,
                    key_char: Some(ch.to_string()),
                };
                window.dispatch_keystroke(keystroke, cx);
            }
        }
        "enter" => {
            window.dispatch_keystroke(Keystroke::parse("enter")?, cx);
        }
        "paste" => {
            let text = arg.replace("\\n", "\n");
            terminal(shell, cx).update(cx, |t, cx| t.paste_text(&text, false, cx));
        }
        "scroll" => {
            let dy = nums()?[0];
            let b = window.bounds();
            window.dispatch_event(
                PlatformInput::Scroll(ScrollEvent {
                    position: point(b.size.width / 2.0, b.size.height / 2.0),
                    delta: ScrollDelta::Pixels(point(px(0.0), px(dy))),
                    modifiers: Modifiers::default(),
                    touch_phase: TouchPhase::Moved,
                    source: ScrollSource::Pointer,
                }),
                cx,
            );
        }
        "resize" => {
            let n = nums()?;
            window.resize(size(px(n[0]), px(n[1])));
        }
        "theme" => {
            let mode = match arg.trim() {
                "light" => ThemeMode::Light,
                "dark" => ThemeMode::Dark,
                other => bail!("theme {other}?"),
            };
            Theme::change(mode, Some(window), cx);
            window.refresh();
        }
        "drag" => {
            let n = nums()?;
            let t = terminal(shell, cx);
            let from = cell_center(&t, n[0], n[1], cx)?;
            let to = cell_center(&t, n[2], n[3], cx)?;
            mouse_down(window, cx, from, 1);
            for i in 1..=4 {
                let p = from + (to - from) * (i as f32 / 4.0);
                window.dispatch_event(
                    PlatformInput::MouseMove(MouseMoveEvent {
                        position: p,
                        pressed_button: Some(MouseButton::Left),
                        modifiers: Modifiers::default(),
                    }),
                    cx,
                );
            }
            mouse_up(window, cx, to, 1);
        }
        "click" => {
            let n = nums()?;
            let t = terminal(shell, cx);
            let at = cell_center(&t, n[0], n[1], cx)?;
            for count in 1..=n.get(2).copied().unwrap_or(1.0) as usize {
                mouse_down(window, cx, at, count);
                mouse_up(window, cx, at, count);
            }
        }
        "copy" => {
            let saved = cx.read_from_clipboard();
            window.dispatch_action(Box::new(ducky_terminal::actions::Copy), cx);
            let path = arg.trim().to_owned();
            // Actions dispatch at the end of the effect cycle; read the clipboard after that.
            cx.defer(move |cx| {
                let copied = cx.read_from_clipboard().and_then(|c| c.text());
                if let Some(saved) = saved {
                    cx.write_to_clipboard(saved);
                }
                let _ = std::fs::write(path, copied.unwrap_or_default());
            });
        }
        "preedit" | "commit" => {
            let t = terminal(shell, cx);
            t.update(cx, |t, cx| {
                if cmd == "preedit" {
                    t.replace_and_mark_text_in_range(None, arg, None, window, cx)
                } else {
                    t.replace_text_in_range(None, arg, window, cx)
                }
            });
        }
        "hover" => {
            let n = nums()?;
            let t = terminal(shell, cx);
            let at = cell_center(&t, n[0], n[1], cx)?;
            let modifiers = Modifiers {
                platform: cfg!(target_os = "macos"),
                control: !cfg!(target_os = "macos"),
                ..Default::default()
            };
            window.dispatch_event(
                PlatformInput::MouseMove(MouseMoveEvent {
                    position: at,
                    pressed_button: None,
                    modifiers,
                }),
                cx,
            );
            if n.get(2).is_some() {
                window.dispatch_event(
                    PlatformInput::MouseDown(MouseDownEvent {
                        button: MouseButton::Left,
                        position: at,
                        modifiers,
                        click_count: 1,
                        first_mouse: false,
                    }),
                    cx,
                );
            }
        }
        "dump" => {
            let text = terminal(shell, cx).read(cx).visible_text();
            std::fs::write(arg.trim(), text)?;
        }
        "shot" => {
            window.render_to_image()?.save(arg.trim())?;
        }
        _ => bail!("unknown command"),
    }
    Ok(())
}

fn cell_center(
    t: &Entity<TerminalView>,
    col: f32,
    row: f32,
    cx: &App,
) -> anyhow::Result<Point<Pixels>> {
    let cell = t
        .read(cx)
        .cell_bounds(col as u16, row as u16)
        .context("terminal not laid out")?;
    Ok(cell.center())
}

fn mouse_down(window: &mut Window, cx: &mut App, position: Point<Pixels>, click_count: usize) {
    window.dispatch_event(
        PlatformInput::MouseDown(MouseDownEvent {
            button: MouseButton::Left,
            position,
            modifiers: Modifiers::default(),
            click_count,
            first_mouse: false,
        }),
        cx,
    );
}

fn mouse_up(window: &mut Window, cx: &mut App, position: Point<Pixels>, click_count: usize) {
    window.dispatch_event(
        PlatformInput::MouseUp(MouseUpEvent {
            button: MouseButton::Left,
            position,
            modifiers: Modifiers::default(),
            click_count,
        }),
        cx,
    );
}
