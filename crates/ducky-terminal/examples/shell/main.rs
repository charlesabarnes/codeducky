//! A window with a `TerminalView` running the login shell in a local PTY.
//!
//! `cargo run -p ducky-terminal --example shell --features pty`
//! With `--features pty,screenshot` it also listens on `/tmp/ducky-terminal.sock` for scripted
//! input and screenshots (see `ctl.rs`). `DUCKY_THEME=light|dark` forces a theme.

#[cfg(feature = "screenshot")]
mod ctl;

use ducky_terminal::source::{LocalPtySource, PtyCommand};
use ducky_terminal::{TerminalConfig, TerminalEvent, TerminalView};
use gpui_kit::component::{ActiveTheme, Theme, ThemeMode, TitleBar};
use gpui_kit::*;

actions!(shell_example, [Quit]);

pub struct Shell {
    terminal: Entity<TerminalView>,
    title: SharedString,
    _events: Subscription,
}

impl Shell {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let command = PtyCommand {
            cwd: std::env::var_os("DUCKY_CWD").map(Into::into),
            ..PtyCommand::default()
        };
        let source = Box::new(LocalPtySource::new(command));
        let terminal =
            cx.new(|cx| TerminalView::new(source, TerminalConfig::default(), window, cx));
        let events = cx.subscribe(&terminal, |shell, terminal, event: &TerminalEvent, cx| {
            match event {
                TerminalEvent::TitleChanged(title) => shell.title = title.clone().into(),
                TerminalEvent::Closed(reason) => {
                    eprintln!("terminal closed: {reason:?}");
                    cx.quit();
                }
                TerminalEvent::OpenLink(url) => {
                    eprintln!("open link: {url}");
                    if std::env::var_os("DUCKY_NO_OPEN").is_none() {
                        cx.open_url(url);
                    }
                }
                TerminalEvent::UnsafePaste(text) => {
                    eprintln!("unsafe paste confirmed by the demo ({} bytes)", text.len());
                    let text = text.clone();
                    terminal.update(cx, |t, cx| t.paste_text(&text, true, cx));
                }
                TerminalEvent::Bell => eprintln!("bell"),
                TerminalEvent::CwdChanged(cwd) => eprintln!("cwd: {cwd}"),
                TerminalEvent::Attached => {}
            }
            cx.notify();
        });
        window.focus(&terminal.focus_handle(cx), cx);
        Self {
            terminal,
            title: "shell".into(),
            _events: events,
        }
    }

    pub fn terminal(&self) -> &Entity<TerminalView> {
        &self.terminal
    }
}

impl Render for Shell {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let grid = self
            .terminal
            .read(cx)
            .grid()
            .map(|g| format!("{}x{}", g.cols, g.rows))
            .unwrap_or_default();
        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(cx.theme().background)
            .child(
                TitleBar::new().child(
                    div()
                        .flex()
                        .gap_2()
                        .text_sm()
                        .text_color(cx.theme().muted_foreground)
                        .child(self.title.clone())
                        .child(grid),
                ),
            )
            .child(div().flex_1().min_h_0().child(self.terminal.clone()))
    }
}

fn main() {
    gpui_kit::application().run(|cx| {
        gpui_kit::init(cx);
        ducky_terminal::init(cx);
        match std::env::var("DUCKY_THEME").as_deref() {
            Ok("light") => Theme::change(ThemeMode::Light, None, cx),
            Ok("dark") => Theme::change(ThemeMode::Dark, None, cx),
            _ => Theme::sync_system_appearance(None, cx),
        }
        cx.on_action(|_: &Quit, cx| cx.quit());
        cx.bind_keys([KeyBinding::new(
            if cfg!(target_os = "macos") {
                "cmd-q"
            } else {
                "ctrl-q"
            },
            Quit,
            None,
        )]);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                None,
                size(px(960.), px(620.)),
                cx,
            ))),
            ..TitleBar::window_options()
        };
        let (_window, _shell) = gpui_kit::open_window(options, cx, |window, cx| {
            let shell = cx.new(|cx| Shell::new(window, cx));
            #[cfg(feature = "screenshot")]
            ctl::start(shell.clone(), window, cx);
            shell
        })
        .expect("open window");
        cx.activate(true);
    });
}
