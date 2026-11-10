use gpui_kit::component::{ActiveTheme, TitleBar, h_flex, v_flex};
use gpui_kit::*;

use crate::app::TITLE;
use crate::theme;

const SIDEBAR_WIDTH: f32 = 260.;
const BOTTOM_PANEL_HEIGHT: f32 = 220.;

pub struct Workspace {
    _appearance: Subscription,
}

impl Workspace {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self {
            _appearance: theme::follow_system(window, cx),
        }
    }
}

impl Render for Workspace {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let sidebar = v_flex()
            .id("sidebar")
            .w(px(SIDEBAR_WIDTH))
            .h_full()
            .flex_none()
            .bg(theme.sidebar)
            .border_r_1()
            .border_color(theme.sidebar_border)
            .child(placeholder("Sidebar", theme.muted_foreground));
        let main = v_flex()
            .id("main")
            .flex_1()
            .min_h_0()
            .child(placeholder("Main", theme.muted_foreground));
        let bottom_panel = v_flex()
            .id("bottom-panel")
            .h(px(BOTTOM_PANEL_HEIGHT))
            .flex_none()
            .border_t_1()
            .border_color(theme.border)
            .child(placeholder("Panel", theme.muted_foreground));

        v_flex()
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .child(TitleBar::new().child(div().text_sm().child(TITLE)))
            .child(
                h_flex().flex_1().min_h_0().child(sidebar).child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .h_full()
                        .child(main)
                        .child(bottom_panel),
                ),
            )
    }
}

fn placeholder(label: &'static str, color: Hsla) -> impl IntoElement {
    div()
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .text_sm()
        .text_color(color)
        .child(label)
}
