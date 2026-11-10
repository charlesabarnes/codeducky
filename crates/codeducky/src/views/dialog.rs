//! The frame every small dialog shares: a dimmed backdrop, a titled card, and the `Dialog` key
//! context (escape closes, the save key submits).

use gpui_kit::component::{ActiveTheme, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::keymap::{CloseDialog, DIALOG};
use crate::theme::ActiveCode;

pub fn frame(
    id: &'static str,
    title: impl Into<SharedString>,
    width: f32,
    cx: &App,
) -> Stateful<Div> {
    let theme = cx.theme();
    v_flex()
        .id(id)
        .key_context(DIALOG)
        .w(px(width))
        .max_h(px(620.))
        .overflow_y_scroll()
        .p_4()
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
                        .text_size(px(15.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(title.into()),
                )
                .child(
                    div()
                        .id("dialog-close")
                        .px_1()
                        .cursor_pointer()
                        .text_color(theme.muted_foreground)
                        .child("esc")
                        .on_click(|_, window, cx| {
                            window.dispatch_action(Box::new(CloseDialog), cx)
                        }),
                ),
        )
}

/// Covers the window and centres `card` near the top.
pub fn backdrop(card: impl IntoElement, cx: &App) -> Div {
    div()
        .absolute()
        .inset_0()
        .flex()
        .justify_center()
        .items_start()
        .pt(px(72.))
        .bg(cx.theme().background.opacity(0.55))
        .child(card)
}

/// A labelled row in a form.
pub fn field(label: &'static str, input: impl IntoElement, cx: &App) -> Div {
    v_flex()
        .gap_1()
        .child(div().text_color(cx.theme().muted_foreground).child(label))
        .child(input)
}

pub fn error_line(error: Option<&str>, cx: &App) -> Option<Div> {
    error.map(|text| div().text_color(cx.code().del).child(text.to_owned()))
}

/// A choice among a few, filled when picked.
pub fn chip(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    on: bool,
    cx: &App,
) -> Stateful<Div> {
    let theme = cx.theme();
    let code = cx.code();
    div()
        .id(id.into())
        .px_2()
        .py_0p5()
        .rounded(theme.radius)
        .border_1()
        .border_color(theme.border)
        .cursor_pointer()
        .when(on, |this| {
            this.bg(theme.foreground).text_color(theme.background)
        })
        .when(!on, |this| this.hover(|this| this.bg(code.bg_2)))
        .child(label.into())
}
