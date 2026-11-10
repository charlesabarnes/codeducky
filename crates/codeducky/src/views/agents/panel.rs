//! The panel under the diff: the repo's terminals as tabs, the picked one live in a terminal
//! view, and what to do when herdr-core is missing or gone.

use ducky_session::agents::status_text;
use ducky_terminal::{TerminalConfig, TerminalEvent, TerminalView};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{ActiveTheme, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::tabs;
use crate::keymap::{
    AGENTS_KEYS, AskFix, AskMessage, AskReview, FOCUS_TERMINAL_KEYS, ReconnectCore, StartAgent,
    ToggleAgents,
};
use crate::state::agents::Line;
use crate::state::{AgentsEvent, AgentsModel};
use crate::theme::ActiveCode;
use crate::views::widgets::{key_hint, muted};

/// The terminal on screen.
pub struct Shown {
    pub address: String,
    pub view: Entity<TerminalView>,
    /// Why the stream ended, while it is closed.
    pub closed: Option<String>,
    _events: Subscription,
}

pub struct AgentsPanel {
    agents: Entity<AgentsModel>,
    pub shown: Option<Shown>,
    /// A paste the terminal held back because it could run commands.
    paste: Option<String>,
    _subscriptions: Vec<Subscription>,
}

impl AgentsPanel {
    pub fn new(agents: Entity<AgentsModel>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![
            cx.observe(&agents, |_, _, cx| cx.notify()),
            cx.subscribe_in(&agents, window, |this, _, event, window, cx| {
                if let AgentsEvent::Show(address) = event {
                    this.show(address.clone(), window, cx);
                }
            }),
        ];
        Self {
            agents,
            shown: None,
            paste: None,
            _subscriptions: subscriptions,
        }
    }

    pub fn terminal_focus(&self, cx: &App) -> Option<FocusHandle> {
        self.shown.as_ref().map(|s| s.view.focus_handle(cx))
    }

    fn config(cx: &App) -> TerminalConfig {
        TerminalConfig {
            font_size: f32::from(cx.code().metrics.code),
            ..TerminalConfig::default()
        }
    }

    fn show(&mut self, address: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.paste = None;
        let Some(address) = address else {
            self.shown = None;
            cx.notify();
            return;
        };
        if self.shown.as_ref().is_some_and(|s| s.address == address) {
            return;
        }
        let Some(source) = self.agents.read(cx).service().map(|s| s.source(&address)) else {
            return;
        };
        let config = Self::config(cx);
        let view = cx.new(|cx| TerminalView::new(Box::new(source), config, window, cx));
        let events = cx.subscribe_in(&view, window, {
            let address = address.clone();
            move |this, view, event: &TerminalEvent, window, cx| {
                this.on_terminal(&address, view, event, window, cx)
            }
        });
        window.focus(&view.focus_handle(cx), cx);
        self.shown = Some(Shown {
            address,
            view,
            closed: None,
            _events: events,
        });
        cx.notify();
    }

    fn on_terminal(
        &mut self,
        address: &str,
        view: &Entity<TerminalView>,
        event: &TerminalEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            TerminalEvent::Bell => {
                if !view.focus_handle(cx).is_focused(window) {
                    self.agents.update(cx, |m, cx| m.ring(address, cx));
                }
            }
            TerminalEvent::Closed(reason) => {
                if let Some(shown) = self.shown.as_mut() {
                    shown.closed = Some(match reason {
                        ducky_terminal::source::CloseReason::Exited { code: Some(code) } => {
                            format!("exited with {code}")
                        }
                        ducky_terminal::source::CloseReason::Exited { code: None } => {
                            "exited".into()
                        }
                        ducky_terminal::source::CloseReason::Lost(why) => format!("lost: {why}"),
                        ducky_terminal::source::CloseReason::Detached => "detached".into(),
                    });
                }
            }
            TerminalEvent::Attached => {
                if let Some(shown) = self.shown.as_mut() {
                    shown.closed = None;
                }
            }
            TerminalEvent::UnsafePaste(text) => self.paste = Some(text.clone()),
            TerminalEvent::OpenLink(url) => cx.open_url(url),
            TerminalEvent::TitleChanged(_) | TerminalEvent::CwdChanged(_) => {}
        }
        cx.notify();
    }

    fn reattach(&mut self, cx: &mut Context<Self>) {
        if let Some(shown) = &self.shown {
            shown.view.update(cx, |view, cx| view.reattach(cx));
        }
    }

    fn confirm_paste(&mut self, send: bool, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.paste.take();
        if let (Some(text), Some(shown), true) = (text, &self.shown, send) {
            shown.view.update(cx, |view, cx| {
                view.paste_text(&text, true, cx);
            });
            window.focus(&shown.view.focus_handle(cx), cx);
        }
        cx.notify();
    }

    fn header(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let code = *cx.code();
        let model = self.agents.read(cx);
        let weak = self.agents.downgrade();
        let tabs = model.agents.iter().map(|agent| {
            tabs::tab(
                agent,
                model.marks.get(&agent.address),
                model.selected.as_deref() == Some(agent.address.as_str()),
                weak.clone(),
                cx,
            )
        });
        let ready = model.line == Line::Ready;
        let button = |id: &'static str, label: &'static str, keys: &'static str| {
            h_flex()
                .id(id)
                .flex_none()
                .gap_1()
                .px_1p5()
                .rounded(theme.radius)
                .cursor_pointer()
                .hover(|this| this.bg(code.bg_3))
                .child(label)
                .child(div().text_color(code.accent).child(keys))
        };
        h_flex()
            .h(code.metrics.bar)
            .flex_none()
            .bg(code.bg_2)
            .border_b_1()
            .border_color(theme.border)
            .font_family(theme.mono_font_family.clone())
            .child(
                div()
                    .flex_none()
                    .px(code.metrics.pad_x)
                    .font_weight(FontWeight::BOLD)
                    .child("agents"),
            )
            .child(
                h_flex()
                    .id("agent-tabs")
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .overflow_x_scroll()
                    .border_l_1()
                    .border_color(theme.border)
                    .children(tabs),
            )
            .when(ready, |this| {
                this.child(
                    button("agent-new", "+ agent", "a n")
                        .on_click(|_, w, cx| w.dispatch_action(Box::new(StartAgent), cx)),
                )
                .child(
                    button("agent-review", "review", "a r")
                        .on_click(|_, w, cx| w.dispatch_action(Box::new(AskReview), cx)),
                )
                .child(
                    button("agent-fix", "fix notes", "a f")
                        .on_click(|_, w, cx| w.dispatch_action(Box::new(AskFix), cx)),
                )
                .child(
                    button("agent-message", "message…", "a m")
                        .on_click(|_, w, cx| w.dispatch_action(Box::new(AskMessage), cx)),
                )
            })
            .when(self.shown.is_some(), |this| {
                this.child(
                    h_flex()
                        .flex_none()
                        .gap_1()
                        .px_1p5()
                        .text_color(theme.muted_foreground)
                        .child("focus")
                        .child(key_hint(FOCUS_TERMINAL_KEYS, cx)),
                )
            })
            .child(
                button("agent-hide", "hide", AGENTS_KEYS)
                    .mr_1()
                    .on_click(|_, w, cx| w.dispatch_action(Box::new(ToggleAgents), cx)),
            )
            .into_any_element()
    }

    fn message(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let model = self.agents.read(cx);
        let retry = |label: &'static str| {
            Button::new("agents-retry")
                .label(label)
                .small()
                .primary()
                .on_click(|_, window, cx| window.dispatch_action(Box::new(ReconnectCore), cx))
        };
        let (text, action): (String, Option<Button>) = match &model.line {
            Line::NoReview => ("open a review to see its agents".into(), None),
            Line::NeedsCore { .. } => (
                "Agents need herdr-core, and it is not running here. Start it (`hc server \
                 status` in a terminal), then connect again."
                    .into(),
                Some(retry("Connect again")),
            ),
            Line::Connecting => ("looking for agents in this repo…".into(), None),
            Line::Failed(error) => (
                format!("Could not list this repo's agents: {error}"),
                Some(retry("Try again")),
            ),
            Line::Disconnected { .. } | Line::Ready => return None,
        };
        Some(
            v_flex()
                .flex_1()
                .items_center()
                .justify_center()
                .gap_3()
                .p_4()
                .child(muted(text, cx).max_w(px(560.)).text_center())
                .children(action)
                .into_any_element(),
        )
    }

    fn banner(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let Line::Disconnected { reason } = &self.agents.read(cx).line else {
            return None;
        };
        let code = *cx.code();
        Some(
            h_flex()
                .flex_none()
                .gap_2()
                .px(code.metrics.pad_x)
                .py_1()
                .bg(code.modified.opacity(0.15))
                .child(div().flex_1().child(format!(
                    "Lost herdr-core ({reason}); the list may be stale."
                )))
                .child(
                    Button::new("agents-reconnect")
                        .label("Reconnect")
                        .small()
                        .on_click(|_, w, cx| w.dispatch_action(Box::new(ReconnectCore), cx)),
                )
                .into_any_element(),
        )
    }

    fn body(&mut self, cx: &mut Context<Self>) -> AnyElement {
        if let Some(message) = self.message(cx) {
            return message;
        }
        let code = *cx.code();
        let model = self.agents.read(cx);
        let Some(shown) = &self.shown else {
            let text = if model.agents.is_empty() {
                "No agents or terminals in this repo yet. Start one with a n, or ask for a \
                 review (a r) or a fix (a f) and one starts for it."
            } else {
                "Pick a terminal above to show it here."
            };
            return v_flex()
                .flex_1()
                .items_center()
                .justify_center()
                .child(muted(text, cx).max_w(px(520.)).text_center())
                .into_any_element();
        };
        let address = shown.address.clone();
        let exited = model
            .agent(&address)
            .filter(|a| !a.is_live())
            .map(|a| status_text(&a.status));
        let closed = shown.closed.clone().or(exited);
        let closed_bar = closed.map(|why| {
            let remove_address = address.clone();
            let agents = self.agents.downgrade();
            h_flex()
                .flex_none()
                .gap_2()
                .px(code.metrics.pad_x)
                .py_1()
                .bg(code.bg_3)
                .child(
                    div()
                        .flex_1()
                        .child(format!("{} {why}", model.label(&address))),
                )
                .child(
                    Button::new("terminal-reattach")
                        .label("Reattach")
                        .small()
                        .on_click(cx.listener(|this, _, _, cx| this.reattach(cx))),
                )
                .child(
                    Button::new("terminal-remove")
                        .label("Remove")
                        .small()
                        .on_click(move |_, _, cx| {
                            let address = remove_address.clone();
                            agents.update(cx, |m, cx| m.remove(address, cx)).ok();
                        }),
                )
        });
        let paste_bar =
            self.paste.as_ref().map(|text| {
                let lines = text.lines().count();
                h_flex()
                    .flex_none()
                    .gap_2()
                    .px(code.metrics.pad_x)
                    .py_1()
                    .bg(code.modified.opacity(0.15))
                    .child(div().flex_1().child(format!(
                        "This paste has {lines} line{} and could run commands as it lands.",
                        if lines == 1 { "" } else { "s" }
                    )))
                    .child(
                        Button::new("paste-anyway")
                            .label("Paste anyway")
                            .small()
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.confirm_paste(true, window, cx)
                            })),
                    )
                    .child(
                        Button::new("paste-cancel")
                            .label("Cancel")
                            .small()
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.confirm_paste(false, window, cx)
                            })),
                    )
            });
        let details = model.agent(&address).map(|agent| {
            tabs::details(agent, cx)
                .flex_none()
                .px(code.metrics.pad_x)
                .py_0p5()
                .border_b_1()
                .border_color(cx.theme().border)
                .font_family(cx.theme().mono_font_family.clone())
        });
        v_flex()
            .flex_1()
            .min_h_0()
            .children(details)
            .children(closed_bar)
            .children(paste_bar)
            .child(div().flex_1().min_h_0().child(shown.view.clone()))
            .into_any_element()
    }
}

impl Render for AgentsPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let header = self.header(cx);
        let banner = self.banner(cx);
        let body = self.body(cx);
        v_flex()
            .id("agents-panel")
            .size_full()
            .bg(theme.background)
            .child(header)
            .children(banner)
            .child(body)
    }
}
