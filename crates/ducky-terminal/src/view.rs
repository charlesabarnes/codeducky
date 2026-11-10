//! `TerminalView`: a GPUI entity that shows one [`TerminalSource`] through a [`Session`].

use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::component::{ActiveTheme, Theme};
use gpui_kit::{
    App, Bounds, ClipboardItem, Context, CursorStyle, DispatchPhase, ElementInputHandler,
    EventEmitter, FocusHandle, Focusable, HitboxBehavior, InteractiveElement, IntoElement,
    KeyDownEvent, Modifiers, ModifiersChangedEvent, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, ParentElement, Pixels, Render, ScrollEvent, SharedString, Styled, Task, Window,
    canvas, div,
};
use libghostty_vt::mouse::{Action as MouseAction, Button};
use libghostty_vt::screen::Screen;
use libghostty_vt::terminal::{Mode, ScrollViewport};

use crate::actions::{self, KEY_CONTEXT};
use crate::config::TerminalConfig;
use crate::element::{self, Metrics, PaintInput};
use crate::frame::{Frame, FrameBuilder};
use crate::input::keys::{KeyEncoder, KeyOptions, KeyRoute, route};
use crate::input::mouse::{Geometry, MouseReporter, mods};
use crate::links::{self, Link};
use crate::selection::{self, Selector};
use crate::session::{PasteOutcome, Session, SessionOptions, TerminalEvent};
use crate::source::{GridSize, TerminalSource};
use crate::theme::TerminalColors;

const BLINK: Duration = Duration::from_millis(530);
const MIN_COLS: u16 = 2;

pub struct TerminalView {
    session: Session,
    config: TerminalConfig,
    frames: FrameBuilder,
    frame: Rc<Frame>,
    frame_generation: u64,
    keys: KeyEncoder,
    mouse: MouseReporter,
    selector: Selector,
    focus: FocusHandle,
    metrics: Option<Metrics>,
    bounds: Option<Bounds<Pixels>>,
    scroll_remainder: f32,
    cursor_on: bool,
    last_input: Instant,
    modifiers: Modifiers,
    hovered_link: Option<Link>,
    pointer: Option<(f32, f32)>,
    reporting_button: Option<Button>,
    scrollbar_drag: bool,
    pub(crate) preedit: Option<String>,
    title: Option<SharedString>,
    _blink: Task<()>,
    _theme: gpui_kit::Subscription,
    _activation: gpui_kit::Subscription,
}

impl EventEmitter<TerminalEvent> for TerminalView {}

impl Focusable for TerminalView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl TerminalView {
    /// Attaches to `source` once the view has been laid out and its grid size is known.
    pub fn new(
        source: Box<dyn TerminalSource>,
        config: TerminalConfig,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let colors = config
            .colors
            .clone()
            .unwrap_or_else(|| TerminalColors::from_theme(cx.theme()));
        let session = Session::new(
            source,
            SessionOptions {
                history: config.history,
                scrollback_lines: config.scrollback_lines,
                colors,
            },
        );
        let blink = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(BLINK).await;
                if this.update(cx, |view, cx| view.blink(cx)).is_err() {
                    return;
                }
            }
        });
        Self {
            session,
            config,
            frames: FrameBuilder::new().expect("libghostty render state"),
            frame: Rc::default(),
            frame_generation: 0,
            keys: KeyEncoder::new().expect("libghostty key encoder"),
            mouse: MouseReporter::new().expect("libghostty mouse encoder"),
            selector: Selector::new().expect("libghostty selection gesture"),
            focus: cx.focus_handle(),
            metrics: None,
            bounds: None,
            scroll_remainder: 0.0,
            cursor_on: true,
            last_input: Instant::now(),
            modifiers: Modifiers::default(),
            hovered_link: None,
            pointer: None,
            reporting_button: None,
            scrollbar_drag: false,
            preedit: None,
            title: None,
            _blink: blink,
            _theme: cx.observe_global_in::<Theme>(window, |view, _, cx| view.theme_changed(cx)),
            _activation: cx.observe_window_activation(window, |_, _, cx| cx.notify()),
        }
    }

    pub fn title(&self) -> Option<&SharedString> {
        self.title.as_ref()
    }

    pub fn is_closed(&self) -> bool {
        self.session.is_closed()
    }

    pub fn grid(&self) -> Option<GridSize> {
        self.session.grid()
    }

    pub fn config(&self) -> &TerminalConfig {
        &self.config
    }

    /// Font, colours and paste policy take effect at once; history applies to the next attach.
    pub fn set_config(&mut self, config: TerminalConfig, cx: &mut Context<Self>) {
        self.session.set_history(config.history);
        self.config = config;
        self.metrics = None;
        self.theme_changed(cx);
    }

    /// The visible text, one line per row.
    pub fn visible_text(&self) -> String {
        self.frame.text()
    }

    /// A cell's bounds in window coordinates, once laid out.
    pub fn cell_bounds(&self, col: u16, row: u16) -> Option<Bounds<Pixels>> {
        let (bounds, m) = (self.bounds?, self.metrics.as_ref()?);
        Some(m.cell_bounds(m.grid_origin(bounds), col, row, 1))
    }

    pub fn selected_text(&self) -> Option<String> {
        self.session.terminal().and_then(selection::selected_text)
    }

    /// Attach again, replaying the program's screen and `history` lines.
    pub fn reattach(&mut self, cx: &mut Context<Self>) {
        let _ = self.session.reattach();
        self.after_session(cx);
    }

    /// Sends text as if typed; no paste handling.
    pub fn send_text(&mut self, text: &str, cx: &mut Context<Self>) {
        self.user_input(text.as_bytes(), cx);
    }

    /// Pastes `text`; with `allow_unsafe` it sends text an unsafe-paste prompt held back.
    pub fn paste_text(
        &mut self,
        text: &str,
        allow_unsafe: bool,
        cx: &mut Context<Self>,
    ) -> PasteOutcome {
        self.clear_selection();
        let outcome = self.session.paste(text, allow_unsafe);
        self.after_session(cx);
        outcome
    }

    fn colors(&self) -> &TerminalColors {
        self.session.colors()
    }

    fn theme_changed(&mut self, cx: &mut Context<Self>) {
        let colors = self
            .config
            .colors
            .clone()
            .unwrap_or_else(|| TerminalColors::from_theme(cx.theme()));
        self.session.set_colors(colors);
        self.frames.invalidate();
        self.metrics = None;
        cx.notify();
    }

    fn blink(&mut self, cx: &mut Context<Self>) {
        let blinking = self.config.cursor_blink
            && self.frame.cursor.as_ref().is_some_and(|c| c.blinking)
            && self.last_input.elapsed() > BLINK;
        let next = !blinking || !self.cursor_on;
        if next != self.cursor_on {
            self.cursor_on = next;
            cx.notify();
        }
    }

    /// Picks up a new stream, events and repaint after anything that touched the session.
    fn after_session(&mut self, cx: &mut Context<Self>) {
        if let Some((generation, rx)) = self.session.take_stream() {
            cx.spawn(async move |this, cx| {
                loop {
                    let Ok(first) = rx.recv_async().await else {
                        let _ = this.update(cx, |view, cx| {
                            view.session.stream_ended(generation);
                            view.after_session(cx);
                        });
                        return;
                    };
                    let mut batch = vec![first];
                    batch.extend(rx.try_iter().take(512));
                    let current = this.update(cx, |view, cx| {
                        for event in batch {
                            view.session.handle(generation, event);
                        }
                        view.after_session(cx);
                        view.session.generation() == generation
                    });
                    if !matches!(current, Ok(true)) {
                        return;
                    }
                }
            })
            .detach();
        }
        if self.session.generation() != self.frame_generation {
            self.frame_generation = self.session.generation();
            self.frames.invalidate();
            self.selector = Selector::new().expect("libghostty selection gesture");
            self.hovered_link = None;
        }
        for event in self.session.take_events() {
            if let TerminalEvent::TitleChanged(title) = &event {
                self.title = Some(title.clone().into());
            }
            cx.emit(event);
        }
        cx.notify();
    }

    fn user_input(&mut self, bytes: &[u8], cx: &mut Context<Self>) {
        if bytes.is_empty() {
            return;
        }
        self.clear_selection();
        self.session.input(bytes);
        self.cursor_on = true;
        self.last_input = Instant::now();
        self.after_session(cx);
    }

    fn clear_selection(&mut self) {
        if let Some(t) = self.session.terminal() {
            if selection::has_selection(t) {
                self.frames.invalidate();
            }
            self.selector.clear(t);
        }
    }

    fn key_options(&self) -> KeyOptions {
        KeyOptions {
            option_as_alt: self.config.option_as_alt,
        }
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.preedit.is_some() {
            return;
        }
        let Some(terminal) = self.session.terminal() else {
            return;
        };
        let kitty = terminal
            .kitty_keyboard_flags()
            .unwrap_or(libghostty_vt::key::KittyKeyFlags::empty());
        if route(&event.keystroke, kitty, self.key_options()) != KeyRoute::Encode {
            return;
        }
        let bytes = self.keys.encode(
            terminal,
            &event.keystroke,
            event.is_held,
            self.key_options(),
        );
        if !bytes.is_empty() {
            self.user_input(&bytes, cx);
            cx.stop_propagation();
        }
    }

    fn send_key(&mut self, spec: &'static str, cx: &mut Context<Self>) {
        let (Some(terminal), Ok(keystroke)) =
            (self.session.terminal(), gpui_kit::Keystroke::parse(spec))
        else {
            return;
        };
        let bytes = self
            .keys
            .encode(terminal, &keystroke, false, self.key_options());
        self.user_input(&bytes, cx);
    }

    /// Text committed by the platform's text input (plain typing, IME, dead keys).
    pub(crate) fn commit_text(&mut self, text: &str, cx: &mut Context<Self>) {
        self.preedit = None;
        if text.is_empty() {
            cx.notify();
            return;
        }
        let kitty_all = self.session.terminal().is_some_and(|t| {
            t.kitty_keyboard_flags()
                .is_ok_and(|f| f.contains(libghostty_vt::key::KittyKeyFlags::REPORT_ALL))
        });
        let mut chars = text.chars();
        if kitty_all
            && let (Some(ch), None) = (chars.next(), chars.next())
            && let Some(terminal) = self.session.terminal()
        {
            let keystroke = gpui_kit::Keystroke {
                modifiers: Modifiers {
                    shift: ch.is_uppercase(),
                    ..Default::default()
                },
                key: ch.to_lowercase().to_string(),
                key_char: Some(text.to_owned()),
            };
            let bytes = self
                .keys
                .encode(terminal, &keystroke, false, self.key_options());
            if !bytes.is_empty() {
                self.user_input(&bytes, cx);
                return;
            }
        }
        self.user_input(text.as_bytes(), cx);
    }

    pub(crate) fn cursor_bounds(&self) -> Option<Bounds<Pixels>> {
        let (bounds, metrics, cursor) = (
            self.bounds?,
            self.metrics.as_ref()?,
            self.frame.cursor.as_ref()?,
        );
        Some(metrics.cell_bounds(metrics.grid_origin(bounds), cursor.col, cursor.row, 1))
    }

    fn copy(&mut self, cx: &mut Context<Self>) {
        match self.selected_text() {
            Some(text) => cx.write_to_clipboard(ClipboardItem::new_string(text)),
            None => cx.propagate(),
        }
    }

    fn paste(&mut self, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) {
            self.paste_text(&text, self.config.allow_unsafe_paste, cx);
        }
    }

    fn select_all(&mut self, cx: &mut Context<Self>) {
        if let Some(t) = self.session.terminal() {
            selection::select_all(t);
            self.frames.invalidate();
            cx.notify();
        }
    }

    fn scroll(&mut self, scroll: ScrollViewport, cx: &mut Context<Self>) {
        if let Some(t) = self.session.terminal_mut() {
            t.scroll_viewport(scroll);
            cx.notify();
        }
    }

    fn page(&self) -> isize {
        self.session
            .emulator_size()
            .map_or(1, |(_, rows)| (rows.max(2) - 1) as isize)
    }

    fn measure(&mut self, window: &Window, cx: &App) -> Metrics {
        if let Some(m) = &self.metrics {
            return m.clone();
        }
        let family = self
            .config
            .font_family
            .clone()
            .unwrap_or_else(|| cx.theme().mono_font_family.clone());
        let m = Metrics::measure(
            family,
            self.config.font_size,
            self.config.line_height,
            self.config.padding,
            window,
        );
        self.metrics = Some(m.clone());
        m
    }

    fn layout(&mut self, bounds: Bounds<Pixels>, cx: &mut Context<Self>) {
        self.bounds = Some(bounds);
        let Some(m) = self.metrics.clone() else {
            return;
        };
        let inner_w = f32::from(bounds.size.width - m.padding * 2.0);
        let inner_h = f32::from(bounds.size.height - m.padding * 2.0);
        let cols = (inner_w / f32::from(m.cell.width))
            .floor()
            .max(f32::from(MIN_COLS)) as u16;
        let rows = (inner_h / f32::from(m.cell.height)).floor().max(1.0) as u16;
        let size = GridSize {
            cols,
            rows,
            cell_width: f32::from(m.cell.width).round() as u32,
            cell_height: f32::from(m.cell.height).round() as u32,
        };
        if self.session.grid() != Some(size) {
            if let Err(e) = self.session.set_grid(size) {
                self.session.detach();
                cx.emit(TerminalEvent::Closed(crate::source::CloseReason::Lost(
                    e.to_string(),
                )));
            }
            self.after_session(cx);
        }
    }

    fn geometry(&self) -> Option<Geometry> {
        let (bounds, m) = (self.bounds?, self.metrics.as_ref()?);
        let origin = m.grid_origin(bounds);
        Some(Geometry {
            width: f32::from(bounds.size.width),
            height: f32::from(bounds.size.height),
            cell_width: f32::from(m.cell.width),
            cell_height: f32::from(m.cell.height),
            padding: f32::from(origin.x - bounds.origin.x),
        })
    }

    fn local(&self, position: gpui_kit::Point<Pixels>) -> Option<(f32, f32)> {
        let bounds = self.bounds?;
        Some((
            f32::from(position.x - bounds.origin.x),
            f32::from(position.y - bounds.origin.y),
        ))
    }

    /// Mouse goes to the program when it asked for it, unless shift is held.
    fn reports_mouse(&self, modifiers: Modifiers) -> bool {
        !modifiers.shift
            && self
                .session
                .terminal()
                .is_some_and(|t| t.is_mouse_tracking().unwrap_or(false))
    }

    fn link_modifier(modifiers: Modifiers) -> bool {
        if cfg!(target_os = "macos") {
            modifiers.platform
        } else {
            modifiers.control
        }
    }

    fn update_link(&mut self, cx: &mut Context<Self>) {
        let link = (|| {
            if !Self::link_modifier(self.modifiers) {
                return None;
            }
            let (geometry, pos, terminal) =
                (self.geometry()?, self.pointer?, self.session.terminal()?);
            let (cols, rows) = (terminal.cols().ok()?, terminal.rows().ok()?);
            let (col, row) = geometry.cell_at(pos.0, pos.1, cols, rows);
            links::hyperlink_span(terminal, col, row).or_else(|| {
                let cells = &self.frame.rows.get(usize::from(row))?.cells;
                links::url_at(cells, row, col)
            })
        })();
        if link != self.hovered_link {
            self.hovered_link = link;
            cx.notify();
        }
    }

    fn mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        let (Some(pos), Some(geometry)) = (self.local(event.position), self.geometry()) else {
            return;
        };
        self.pointer = Some(pos);
        if let Some(bounds) = self.bounds
            && element::scrollbar_track(bounds).contains(&event.position)
            && self.frame.scrollbar.is_some_and(|b| b.total > b.len)
        {
            self.scrollbar_drag = true;
            self.scroll_to_pointer(event.position, cx);
            return;
        }
        if event.button == MouseButton::Left
            && Self::link_modifier(event.modifiers)
            && let Some(link) = self.hovered_link.clone()
        {
            cx.emit(TerminalEvent::OpenLink(link.url));
            return;
        }
        let Some(terminal) = self.session.terminal() else {
            return;
        };
        if self.reports_mouse(event.modifiers) {
            let button = button(event.button);
            let bytes = self.mouse.encode(
                terminal,
                geometry,
                MouseAction::Press,
                Some(button),
                pos,
                mods(event.modifiers),
                true,
            );
            self.reporting_button = Some(button);
            self.user_input(&bytes, cx);
            return;
        }
        if event.button == MouseButton::Left {
            self.selector.press(terminal, geometry, pos, Instant::now());
            self.frames.invalidate();
            cx.notify();
        }
    }

    fn mouse_move(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        let (Some(pos), Some(geometry)) = (self.local(event.position), self.geometry()) else {
            return;
        };
        self.pointer = Some(pos);
        self.modifiers = event.modifiers;
        if self.scrollbar_drag {
            self.scroll_to_pointer(event.position, cx);
            return;
        }
        let Some(terminal) = self.session.terminal() else {
            return;
        };
        if self.selector.is_active() {
            let rectangle = event.modifiers.alt;
            self.selector.drag(terminal, geometry, pos, rectangle);
            self.frames.invalidate();
            cx.notify();
            return;
        }
        let inside = self.bounds.is_some_and(|b| b.contains(&event.position));
        if inside && self.reports_mouse(event.modifiers) {
            let button = event.pressed_button.map(button);
            let bytes = self.mouse.encode(
                terminal,
                geometry,
                MouseAction::Motion,
                button,
                pos,
                mods(event.modifiers),
                button.is_some(),
            );
            if !bytes.is_empty() {
                self.session.input(&bytes);
                self.after_session(cx);
            }
        }
        self.update_link(cx);
    }

    fn mouse_up(&mut self, event: &MouseUpEvent, cx: &mut Context<Self>) {
        self.scrollbar_drag = false;
        let (Some(pos), Some(geometry)) = (self.local(event.position), self.geometry()) else {
            return;
        };
        let Some(terminal) = self.session.terminal() else {
            return;
        };
        if self.selector.is_active() {
            self.selector.release(terminal, geometry, pos);
            self.frames.invalidate();
            cx.notify();
            return;
        }
        if let Some(button) = self.reporting_button.take() {
            let bytes = self.mouse.encode(
                terminal,
                geometry,
                MouseAction::Release,
                Some(button),
                pos,
                mods(event.modifiers),
                false,
            );
            self.session.input(&bytes);
            self.after_session(cx);
        }
    }

    fn scroll_to_pointer(&mut self, position: gpui_kit::Point<Pixels>, cx: &mut Context<Self>) {
        let (Some(bounds), Some(bar)) = (self.bounds, self.frame.scrollbar) else {
            return;
        };
        let track = element::scrollbar_track(bounds);
        let t = f32::from(position.y - track.origin.y) / f32::from(track.size.height);
        let row = (t.clamp(0.0, 1.0) * bar.total.saturating_sub(bar.len) as f32).round() as usize;
        self.scroll(ScrollViewport::Row(row), cx);
    }

    fn scroll_wheel(&mut self, event: &ScrollEvent, cx: &mut Context<Self>) {
        let Some(m) = self.metrics.clone() else {
            return;
        };
        let dy = f32::from(event.delta.pixel_delta(m.cell.height).y);
        self.scroll_remainder += dy;
        let lines = (self.scroll_remainder / f32::from(m.cell.height)).trunc();
        if lines == 0.0 {
            return;
        }
        self.scroll_remainder -= lines * f32::from(m.cell.height);
        let lines = lines as i32;
        let (Some(pos), Some(geometry)) = (self.local(event.position), self.geometry()) else {
            return;
        };
        let Some(terminal) = self.session.terminal() else {
            return;
        };
        if self.reports_mouse(event.modifiers) {
            let bytes = self
                .mouse
                .wheel(terminal, geometry, pos, lines, mods(event.modifiers));
            self.session.input(&bytes);
            self.after_session(cx);
            return;
        }
        let alternate = matches!(terminal.active_screen(), Ok(Screen::Alternate));
        if alternate && terminal.mode(Mode::ALT_SCROLL).unwrap_or(true) {
            let key = if lines > 0 { "up" } else { "down" };
            for _ in 0..lines.unsigned_abs() {
                self.send_key(key, cx);
            }
            return;
        }
        self.scroll(ScrollViewport::Delta(-(lines as isize)), cx);
    }

    fn cursor_style(&self) -> CursorStyle {
        if self.hovered_link.is_some() {
            CursorStyle::PointingHand
        } else if self.reports_mouse(self.modifiers) {
            CursorStyle::Arrow
        } else {
            CursorStyle::IBeam
        }
    }
}

fn button(b: MouseButton) -> Button {
    match b {
        MouseButton::Left => Button::Left,
        MouseButton::Right => Button::Right,
        MouseButton::Middle => Button::Middle,
        _ => Button::Unknown,
    }
}

impl Render for TerminalView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let focused = self.focus.is_focused(window) && window.is_window_active();
        self.session.set_focus(focused);
        let metrics = self.measure(window, cx);
        if let Some(terminal) = self.session.terminal() {
            self.frame = self.frames.update(terminal);
        }
        let input = PaintInput {
            frame: self.frame.clone(),
            metrics,
            colors: self.colors().clone(),
            focused,
            cursor_visible: self.cursor_on || !focused,
            link: self.hovered_link.clone(),
            preedit: self.preedit.clone(),
            letterbox: self
                .session
                .is_letterboxed()
                .then(|| self.session.emulator_size())
                .flatten(),
        };
        let entity = cx.entity();
        let paint_entity = entity.clone();
        let focus = self.focus.clone();
        let cursor = self.cursor_style();

        div()
            .id("terminal")
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus)
            .size_full()
            .on_key_down(cx.listener(Self::on_key_down))
            .on_modifiers_changed(cx.listener(|view, event: &ModifiersChangedEvent, _, cx| {
                view.modifiers = event.modifiers;
                view.update_link(cx);
                cx.notify();
            }))
            .on_action(cx.listener(|view, _: &actions::Copy, _, cx| view.copy(cx)))
            .on_action(cx.listener(|view, _: &actions::Paste, _, cx| view.paste(cx)))
            .on_action(cx.listener(|view, _: &actions::SelectAll, _, cx| view.select_all(cx)))
            .on_action(cx.listener(|view, _: &actions::SendTab, _, cx| view.send_key("tab", cx)))
            .on_action(
                cx.listener(|view, _: &actions::SendBackTab, _, cx| view.send_key("shift-tab", cx)),
            )
            .on_action(cx.listener(|view, _: &actions::ScrollPageUp, _, cx| {
                let page = view.page();
                view.scroll(ScrollViewport::Delta(-page), cx)
            }))
            .on_action(cx.listener(|view, _: &actions::ScrollPageDown, _, cx| {
                let page = view.page();
                view.scroll(ScrollViewport::Delta(page), cx)
            }))
            .on_action(cx.listener(|view, _: &actions::ScrollToTop, _, cx| {
                view.scroll(ScrollViewport::Top, cx)
            }))
            .on_action(cx.listener(|view, _: &actions::ScrollToBottom, _, cx| {
                view.scroll(ScrollViewport::Bottom, cx)
            }))
            .child(
                canvas(
                    move |bounds, window, cx| {
                        entity.update(cx, |view, cx| view.layout(bounds, cx));
                        window.insert_hitbox(bounds, HitboxBehavior::Normal)
                    },
                    move |bounds, hitbox, window, cx| {
                        window.set_cursor_style(cursor, &hitbox);
                        element::paint(&input, bounds, window, cx);
                        window.handle_input(
                            &focus,
                            ElementInputHandler::new(bounds, paint_entity.clone()),
                            cx,
                        );
                        register_mouse(&paint_entity, &hitbox, window);
                    },
                )
                .size_full(),
            )
    }
}

/// Window-level listeners, so a drag keeps selecting (and a release lands) outside the view.
fn register_mouse(
    entity: &gpui_kit::Entity<TerminalView>,
    hitbox: &gpui_kit::Hitbox,
    window: &mut Window,
) {
    let (e, h) = (entity.clone(), hitbox.clone());
    window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
        if phase == DispatchPhase::Bubble && h.is_hovered(window) {
            e.update(cx, |view, cx| view.mouse_down(event, window, cx));
        }
    });
    let e = entity.clone();
    window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
        if phase == DispatchPhase::Bubble {
            e.update(cx, |view, cx| view.mouse_move(event, cx));
        }
    });
    let e = entity.clone();
    window.on_mouse_event(move |event: &MouseUpEvent, phase, _, cx| {
        if phase == DispatchPhase::Bubble {
            e.update(cx, |view, cx| view.mouse_up(event, cx));
        }
    });
    let (e, h) = (entity.clone(), hitbox.clone());
    window.on_mouse_event(move |event: &ScrollEvent, phase, window, cx| {
        if phase == DispatchPhase::Bubble && h.should_handle_scroll(window) {
            e.update(cx, |view, cx| view.scroll_wheel(event, cx));
        }
    });
}
