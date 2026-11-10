//! The checks tab: the review's checklists with tickable items.

use ducky_review::checklist::ChecklistScope;
use gpui_kit::component::{ActiveTheme, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::keymap::ManageChecklists;
use crate::theme::ActiveCode;
use crate::views::widgets::muted;
use crate::views::workspace::Workspace;

pub fn render(ws: &mut Workspace, _: &mut Window, cx: &mut Context<Workspace>) -> impl IntoElement {
    let theme = cx.theme().clone();
    let code = *cx.code();
    let model = ws.model.read(cx);
    let Some(review) = model.review.as_ref() else {
        return div().into_any_element();
    };
    let state = review.state.clone();
    let lists: Vec<_> = model
        .checklists
        .applicable()
        .into_iter()
        .map(|(scope, list)| (scope, list.clone()))
        .collect();
    let mut item_index = 0usize;
    let cards = lists.into_iter().map(|(scope, list)| {
        let ticked = list
            .items
            .iter()
            .filter(|item| state.is_checked(&item.id))
            .count();
        let header = h_flex()
            .gap_2()
            .child(
                div()
                    .font_weight(FontWeight::BOLD)
                    .child(list.title.clone()),
            )
            .when(list.required, |this| {
                this.child(
                    div()
                        .px_1()
                        .rounded(theme.radius)
                        .bg(code.del.opacity(0.15))
                        .text_color(code.del)
                        .child("required"),
                )
            })
            .when(scope == ChecklistScope::Global, |this| {
                this.child(muted("global", cx))
            })
            .child(div().flex_1())
            .child(muted(format!("{ticked}/{}", list.items.len()), cx));
        let items = list.items.into_iter().map(|item| {
            item_index += 1;
            let checked = state.is_checked(&item.id);
            let id = item.id.clone();
            h_flex()
                .id(("check-item", item_index))
                .gap_2()
                .py_0p5()
                .cursor_pointer()
                .hover(|this| this.bg(code.bg_2))
                .child(
                    div()
                        .flex_none()
                        .text_color(if checked {
                            code.add
                        } else {
                            theme.muted_foreground
                        })
                        .child(if checked { "[x]" } else { "[ ]" }),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .when(checked, |this| this.text_color(theme.muted_foreground))
                        .child(item.text),
                )
                .on_click(cx.listener(move |ws, _, _, cx| {
                    let id = id.clone();
                    ws.model.update(cx, |m, cx| m.toggle_check(id, cx));
                }))
        });
        v_flex().gap_0p5().pb_2().child(header).children(items)
    });
    let empty = model.checklists.is_empty().then(|| {
        div()
            .py_2()
            .child(muted("No checklists for this repo. Create one.", cx))
    });
    v_flex()
        .id("checklists")
        .size_full()
        .overflow_y_scroll()
        .px(code.metrics.pad_x)
        .py_1()
        .font_family(theme.mono_font_family.clone())
        .children(cards)
        .children(empty)
        .child(
            div()
                .id("manage-checklists")
                .cursor_pointer()
                .text_color(code.accent)
                .child("manage checklists")
                .on_click(|_, w, cx| w.dispatch_action(Box::new(ManageChecklists), cx)),
        )
        .into_any_element()
}
