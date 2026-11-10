//! The strip of the repo's terminals: a status dot, name, turn, title and the last task.

use ducky_agents::AgentInfo;
use ducky_session::agents::{StatusTone, status_text, tone};
use gpui_kit::component::{ActiveTheme, h_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::state::AgentsModel;
use crate::state::agents::Marks;
use crate::theme::ActiveCode;

pub fn tone_color(tone: StatusTone, cx: &App) -> Hsla {
    let code = cx.code();
    let theme = cx.theme();
    match tone {
        StatusTone::Working => code.moved,
        StatusTone::Idle => theme.muted_foreground,
        StatusTone::Done => code.add,
        StatusTone::Blocked => code.modified,
        StatusTone::Error => code.del,
        StatusTone::Unreported => theme.muted_foreground.opacity(0.5),
        StatusTone::Exited => code.bg_3,
    }
}

pub fn status_dot(tone: StatusTone, cx: &App) -> Div {
    let color = tone_color(tone, cx);
    let dot = div().size(px(8.)).flex_none().rounded_full();
    match tone {
        StatusTone::Unreported | StatusTone::Exited => dot.border_1().border_color(color),
        _ => dot.bg(color),
    }
}

fn label(agent: &AgentInfo) -> String {
    match &agent.name {
        Some(name) => name.clone(),
        None => agent.address.clone(),
    }
}

pub fn tab(
    agent: &AgentInfo,
    marks: Option<&Marks>,
    selected: bool,
    model: WeakEntity<AgentsModel>,
    cx: &App,
) -> Stateful<Div> {
    let theme = cx.theme();
    let code = cx.code();
    let address = agent.address.clone();
    let task = marks.and_then(|m| m.task.clone());
    let bell = marks.is_some_and(|m| m.bell);
    h_flex()
        .id(SharedString::from(format!("agent-tab-{}", agent.address)))
        .flex_none()
        .h_full()
        .px_2()
        .gap_1p5()
        .border_r_1()
        .border_color(theme.border)
        .cursor_pointer()
        .when(selected, |this| this.bg(theme.background))
        .when(!selected, |this| this.hover(|this| this.bg(code.bg_3)))
        .child(status_dot(tone(&agent.status), cx))
        .child(
            div()
                .when(selected, |this| this.font_weight(FontWeight::SEMIBOLD))
                .when(!agent.is_live(), |this| {
                    this.text_color(theme.muted_foreground)
                })
                .child(label(agent)),
        )
        .children(task.map(|task| div().px_1().rounded(theme.radius).bg(code.bg_3).child(task)))
        .when(bell, |this| {
            this.child(
                div()
                    .size(px(6.))
                    .rounded_full()
                    .border_1()
                    .border_color(code.modified),
            )
        })
        .on_click(move |_, _, cx| {
            let address = address.clone();
            model.update(cx, |m, cx| m.select(Some(address), cx)).ok();
        })
}

/// The picked agent in full: kind, status and its words, turn, title, address.
pub fn details(agent: &AgentInfo, cx: &App) -> Div {
    let theme = cx.theme();
    let mut parts = vec![agent.kind.label().to_owned(), status_text(&agent.status)];
    if let Some(message) = &agent.status_message {
        parts.push(message.clone());
    }
    if agent.turn > 0 {
        parts.push(format!("turn {}", agent.turn));
    }
    let title = agent.title.trim();
    if !title.is_empty() {
        parts.push(title.to_owned());
    }
    h_flex()
        .gap_2()
        .min_w_0()
        .text_color(theme.muted_foreground)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(parts.join(" · ")),
        )
        .child(div().flex_none().child(agent.address.clone()))
}
