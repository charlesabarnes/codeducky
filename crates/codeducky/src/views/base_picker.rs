//! Pick another branch to compare against.

use gpui_kit::component::{ActiveTheme, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::theme::ActiveCode;
use crate::views::workspace::Workspace;

pub fn render(ws: &mut Workspace, cx: &mut Context<Workspace>) -> impl IntoElement {
    let theme = cx.theme().clone();
    let code = *cx.code();
    let model = ws.model.read(cx);
    let Some(review) = model.review.as_ref() else {
        return div().into_any_element();
    };
    let current = review.base.clone();
    let default = review.default_base.clone();
    let head = review.head.branch.clone();
    let rows = review
        .branches
        .iter()
        .filter(|b| Some(&b.name) != head.as_ref())
        .enumerate()
        .map(|(i, branch)| {
            let name = branch.name.clone();
            let on = name == current;
            let label = if Some(&name) == default.as_ref() {
                format!("{name}  (default)")
            } else {
                name.clone()
            };
            div()
                .id(("base-row", i))
                .px_2()
                .py_0p5()
                .cursor_pointer()
                .when(on, |this| this.bg(code.row_current))
                .hover(|this| this.bg(code.bg_2))
                .child(label)
                .on_click(cx.listener(move |ws, _, _, cx| {
                    let base = name.clone();
                    ws.model.update(cx, |m, cx| m.set_base(base, cx));
                }))
        });
    div()
        .absolute()
        .top(code.metrics.bar + px(4.))
        .left(px(260.))
        .child(
            v_flex()
                .id("base-picker")
                .w(px(320.))
                .max_h(px(420.))
                .overflow_y_scroll()
                .py_1()
                .bg(theme.popover)
                .border_1()
                .border_color(theme.border)
                .rounded(theme.radius_lg)
                .font_family(theme.mono_font_family.clone())
                .child(
                    div()
                        .px_2()
                        .pb_1()
                        .text_color(theme.muted_foreground)
                        .child("compare against (esc closes)"),
                )
                .children(rows),
        )
        .into_any_element()
}
