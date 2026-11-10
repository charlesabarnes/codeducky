use gpui_kit::component::TitleBar;
use gpui_kit::*;

use crate::config;
use crate::keymap::{self, Quit};
use crate::state::{GitHubModel, ReviewModel};
use crate::views::workspace::Workspace;

pub const TITLE: &str = "Code Ducky";
const DEFAULT_SIZE: (f32, f32) = (1280., 820.);

pub fn run() {
    #[cfg(feature = "screenshot")]
    let mut script = crate::dev::Script::from_args();
    #[cfg(feature = "screenshot")]
    let core_target = script.core_target();
    #[cfg(feature = "screenshot")]
    let github_setup = script.github_setup();
    #[cfg(not(feature = "screenshot"))]
    let github_setup = crate::state::github::GitHubSetup::real();

    gpui_kit::application().run(move |cx| {
        gpui_kit::init(cx);
        ducky_terminal::init(cx);
        keymap::bind(cx);
        cx.on_action(|_: &Quit, cx| cx.quit());

        #[allow(unused_mut)]
        let mut prefs = config::load();
        #[cfg(feature = "screenshot")]
        let scripted = script.apply_prefs(&mut prefs);
        let model = cx.new(|_| ReviewModel::new(prefs));
        #[cfg(feature = "screenshot")]
        model.update(cx, |m, _| {
            m.persist = !scripted;
            if let Some(target) = core_target.clone() {
                m.core_target = target;
            }
        });
        model.update(cx, |m, cx| m.connect(cx));

        let saver = model.clone();
        cx.on_window_closed(move |cx, _| {
            saver.read(cx).save_prefs();
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        let github = cx.new(|_| GitHubModel::new(github_setup.clone()));
        let workspace = open_main_window(model.clone(), github, cx);
        cx.activate(true);

        #[cfg(feature = "screenshot")]
        crate::dev::run(script, model, workspace, cx);
        #[cfg(not(feature = "screenshot"))]
        let _ = workspace;
    });
}

fn open_main_window(
    model: Entity<ReviewModel>,
    github: Entity<GitHubModel>,
    cx: &mut App,
) -> Entity<Workspace> {
    let (width, height) = model.read(cx).prefs.window.unwrap_or(DEFAULT_SIZE);
    let options = WindowOptions {
        titlebar: Some(TitlebarOptions {
            title: Some(TITLE.into()),
            ..TitleBar::title_bar_options()
        }),
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(width.max(640.)), px(height.max(400.))),
            cx,
        ))),
        ..TitleBar::window_options()
    };
    gpui_kit::open_window(options, cx, |window, cx| {
        cx.new(|cx| Workspace::new(model, github, window, cx))
    })
    .expect("failed to open the main window")
    .1
}
