use gpui_kit::component::TitleBar;
use gpui_kit::*;

use crate::theme;
use crate::workspace::Workspace;

pub const TITLE: &str = "Code Ducky";

actions!(codeducky, [Quit]);

#[cfg(target_os = "macos")]
const QUIT_KEY: &str = "cmd-q";
#[cfg(not(target_os = "macos"))]
const QUIT_KEY: &str = "ctrl-q";

pub fn run() {
    #[cfg(feature = "screenshot")]
    let screenshot = crate::screenshot::path_from_args();

    gpui_kit::application().run(move |cx| {
        gpui_kit::init(cx);
        theme::init(cx);
        cx.on_action(|_: &Quit, cx| cx.quit());
        cx.bind_keys([KeyBinding::new(QUIT_KEY, Quit, None)]);
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        open_main_window(cx);
        cx.activate(true);

        #[cfg(feature = "screenshot")]
        if let Some(path) = screenshot {
            crate::screenshot::capture_then_quit(path, cx);
        }
    });
}

fn open_main_window(cx: &mut App) {
    let options = WindowOptions {
        titlebar: Some(TitlebarOptions {
            title: Some(TITLE.into()),
            ..TitleBar::title_bar_options()
        }),
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(1200.), px(800.)),
            cx,
        ))),
        ..TitleBar::window_options()
    };
    gpui_kit::open_window(options, cx, |window, cx| {
        cx.new(|cx| Workspace::new(window, cx))
    })
    .expect("failed to open the main window");
}
