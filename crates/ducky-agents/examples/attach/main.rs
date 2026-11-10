//! A window with a `TerminalView` on an `HcTerminalSource`, attached to a shell in a scratch
//! herdr-core that this example starts and stops (never the user's live core).
//!
//! `cargo run -p ducky-agents --example attach --features dev`
//!
//! It listens on the ducky-terminal example's control socket (see that example's `ctl.rs`):
//! `printf 'type ls\nenter\nshot /tmp/a.png\n' | nc -U /tmp/ducky-terminal.sock`.
//! `key cmd-q` (ctrl-q on Linux) quits and stops the core. The core's `hc` environment is printed
//! at start, for poking at it by hand.

#[path = "../../../ducky-terminal/examples/shell/ctl.rs"]
mod ctl;

use std::sync::Arc;
use std::time::Duration;

use ducky_agents::HcTerminalSource;
use ducky_hc::scratch::ScratchCore;
use ducky_hc::{Client, RunParams, SendParams, Size};
use ducky_terminal::{TerminalConfig, TerminalEvent, TerminalView};
use gpui_kit::component::{ActiveTheme, Theme, ThemeMode, TitleBar};
use gpui_kit::*;

actions!(attach_example, [Quit]);

/// The name ctl.rs drives.
pub type Shell = AttachWindow;

pub struct AttachWindow {
    terminal: Entity<TerminalView>,
    address: SharedString,
    title: SharedString,
    _events: Subscription,
}

impl AttachWindow {
    fn new(client: Client, address: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let source = Box::new(HcTerminalSource::new(client, address.clone()));
        let terminal =
            cx.new(|cx| TerminalView::new(source, TerminalConfig::default(), window, cx));
        let events = cx.subscribe(&terminal, |this, _, event: &TerminalEvent, cx| {
            match event {
                TerminalEvent::TitleChanged(title) => this.title = title.clone().into(),
                TerminalEvent::Closed(reason) => {
                    eprintln!("terminal closed: {reason:?}");
                    cx.dispatch_action(&Quit);
                }
                other => eprintln!("{other:?}"),
            }
            cx.notify();
        });
        window.focus(&terminal.focus_handle(cx), cx);
        Self {
            terminal,
            address: address.into(),
            title: "shell".into(),
            _events: events,
        }
    }

    pub fn terminal(&self) -> &Entity<TerminalView> {
        &self.terminal
    }
}

impl Render for AttachWindow {
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
                        .child(format!("hc {}", self.address))
                        .child(self.title.clone())
                        .child(grid),
                ),
            )
            .child(div().flex_1().min_h_0().child(self.terminal.clone()))
    }
}

/// A plain bash with a short prompt and some scrollback to replay.
fn start_shell(core: &ScratchCore, client: &Client) -> anyhow::Result<String> {
    let terminal = client.terminal_run(&RunParams {
        argv: vec!["/bin/bash".into(), "--noprofile".into(), "--norc".into()],
        cwd: Some(core.root().to_string_lossy().into_owned()),
        name: Some("demo".into()),
        env: [("PS1".into(), "\\W $ ".into())].into(),
        size: Some(Size {
            cols: 100,
            rows: 30,
        }),
        no_parent: true,
        ..RunParams::default()
    })?;
    client.terminal_send(&SendParams {
        terminal: terminal.address.clone(),
        text: "seq 1 300 | sed 's/^/history line /'".into(),
        force: true,
        ..SendParams::default()
    })?;
    std::thread::sleep(Duration::from_millis(300));
    Ok(terminal.address)
}

fn main() -> anyhow::Result<()> {
    let core = Arc::new(ScratchCore::start("ex")?);
    eprintln!(
        "scratch core: HC_SESSION={} XDG_STATE_HOME={root}/state XDG_CONFIG_HOME={root}/config XDG_RUNTIME_DIR={root}/run",
        core.session(),
        root = core.root().display()
    );
    let client = core.client()?;
    let address = start_shell(&core, &client)?;

    gpui_kit::application().run(move |cx| {
        gpui_kit::init(cx);
        ducky_terminal::init(cx);
        match std::env::var("DUCKY_THEME").as_deref() {
            Ok("light") => Theme::change(ThemeMode::Light, None, cx),
            _ => Theme::change(ThemeMode::Dark, None, cx),
        }
        let quitting = core.clone();
        cx.on_action(move |_: &Quit, cx| {
            quitting.stop();
            cx.quit();
        });
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
        gpui_kit::open_window(options, cx, |window, cx| {
            let view = cx.new(|cx| AttachWindow::new(client.clone(), address.clone(), window, cx));
            ctl::start(view.clone(), window, cx);
            view
        })
        .expect("open window");
        cx.activate(true);
    });
    Ok(())
}
