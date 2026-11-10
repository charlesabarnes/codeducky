//! The shortcut overlay, built from the keymap's table.

use gpui_kit::component::{ActiveTheme, h_flex, v_flex};
use gpui_kit::*;

use crate::keymap::{HELP, ToggleHelp};
use crate::theme::ActiveCode;

pub fn render(cx: &App) -> impl IntoElement {
    let theme = cx.theme();
    let code = cx.code();
    let mut groups: Vec<&str> = Vec::new();
    for shortcut in HELP {
        if !groups.contains(&shortcut.group) {
            groups.push(shortcut.group);
        }
    }
    let columns = groups.into_iter().map(|group| {
        v_flex()
            .gap_0p5()
            .child(
                div()
                    .pb_1()
                    .font_weight(FontWeight::BOLD)
                    .child(group.to_lowercase()),
            )
            .children(HELP.iter().filter(|s| s.group == group).map(|s| {
                h_flex()
                    .gap_3()
                    .child(
                        div()
                            .w(px(130.))
                            .flex_none()
                            .whitespace_nowrap()
                            .font_family(theme.mono_font_family.clone())
                            .text_color(code.accent)
                            .child(s.keys),
                    )
                    .child(div().child(s.label))
            }))
    });
    div()
        .id("help-overlay")
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .bg(theme.background.opacity(0.6))
        .on_click(|_, window, cx| window.dispatch_action(Box::new(ToggleHelp), cx))
        .child(
            v_flex()
                .id("help-panel")
                .max_w(px(1220.))
                .max_h(relative(0.94))
                .overflow_y_scroll()
                .p_5()
                .gap_3()
                .bg(theme.popover)
                .border_1()
                .border_color(theme.border)
                .rounded(theme.radius_lg)
                .child(
                    h_flex()
                        .child(
                            div()
                                .flex_1()
                                .text_size(px(16.))
                                .child("keyboard shortcuts"),
                        )
                        .child(
                            div()
                                .text_color(theme.muted_foreground)
                                .child("? or esc closes"),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_x(px(36.))
                        .gap_y_4()
                        .children(columns),
                ),
        )
}
