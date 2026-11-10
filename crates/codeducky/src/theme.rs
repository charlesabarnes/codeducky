use gpui_kit::component::Theme;
use gpui_kit::*;

pub fn init(cx: &mut App) {
    Theme::sync_system_appearance(None, cx);
}

pub fn follow_system<V: 'static>(window: &mut Window, cx: &mut Context<V>) -> Subscription {
    cx.observe_window_appearance(window, |_, window, cx| {
        Theme::sync_system_appearance(Some(window), cx);
    })
}
