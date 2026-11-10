//! One terminal as seen through a [`TerminalSource`]: the attach lifecycle, the emulator, and the
//! effects it raises. No GPUI here, so it is testable without a window.
//!
//! - Attach waits for the real grid size: replayed history arrives wrapped at the attach width
//!   and does not reflow.
//! - Every attach gets a fresh emulator: the repaint resets the screen, not our scrollback.
//! - Attaching while the program is on the alternate screen replays only that screen, so when
//!   it leaves the alternate screen we attach again to fetch the main screen and history.
//! - For the same reason, a width change on the main screen of at least a quarter of the attach
//!   width (and at least [`REFLOW_MIN_COLS`]) attaches again instead of resizing, so the source
//!   replays history wrapped at the new width. Smaller changes just resize.

use libghostty_vt::focus;
use libghostty_vt::paste;
use libghostty_vt::screen::Screen;
use libghostty_vt::terminal::{ClipboardMime, Mode, ScrollViewport};

use crate::emulator::{Effects, EffectsHandle, Emulator, apply_colors, new_emulator};
use crate::source::{
    AttachRequest, CloseReason, DisplayFacts, GridSize, SourceError, SourceEvent, TerminalSource,
    ViewerMessage,
};
use crate::theme::TerminalColors;

/// Raised to the embedding app.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TerminalEvent {
    TitleChanged(String),
    CwdChanged(String),
    Bell,
    Closed(CloseReason),
    /// A paste was held back because it could run commands; call `paste` with
    /// `allow_unsafe` to send it anyway.
    UnsafePaste(String),
    /// The user cmd/ctrl-clicked a link.
    OpenLink(String),
    /// A fresh attach replaced the screen.
    Attached,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PasteOutcome {
    Sent,
    Empty,
    Rejected,
}

const REFLOW_MIN_COLS: u16 = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    WaitingForSize,
    Attached,
    Closed,
}

pub struct SessionOptions {
    pub history: usize,
    pub scrollback_lines: usize,
    pub colors: TerminalColors,
}

pub struct Session {
    source: Box<dyn TerminalSource>,
    options: SessionOptions,
    phase: Phase,
    grid: Option<GridSize>,
    /// The width the current stream was attached at: its replayed history is wrapped there.
    attached_cols: Option<u16>,
    /// The program's size when another viewer set it; we render that grid letterboxed.
    program_size: Option<(u16, u16)>,
    terminal: Option<(Emulator, EffectsHandle)>,
    stream: Option<flume::Receiver<SourceEvent>>,
    generation: u64,
    /// `None` until the first output of the current attach.
    attached_on_alt: Option<bool>,
    focused: Option<bool>,
    events: Vec<TerminalEvent>,
}

impl Session {
    pub fn new(source: Box<dyn TerminalSource>, options: SessionOptions) -> Self {
        Self {
            source,
            options,
            phase: Phase::WaitingForSize,
            grid: None,
            attached_cols: None,
            program_size: None,
            terminal: None,
            stream: None,
            generation: 0,
            attached_on_alt: None,
            focused: None,
            events: Vec::new(),
        }
    }

    pub fn terminal(&self) -> Option<&Emulator> {
        self.terminal.as_ref().map(|(t, _)| t)
    }

    pub fn terminal_mut(&mut self) -> Option<&mut Emulator> {
        self.terminal.as_mut().map(|(t, _)| t)
    }

    pub fn grid(&self) -> Option<GridSize> {
        self.grid
    }

    /// The grid the emulator runs at: ours, or the program's while letterboxed.
    pub fn emulator_size(&self) -> Option<(u16, u16)> {
        self.program_size
            .or_else(|| self.grid.map(|g| (g.cols, g.rows)))
    }

    pub fn is_letterboxed(&self) -> bool {
        self.program_size.is_some()
    }

    pub fn is_closed(&self) -> bool {
        self.phase == Phase::Closed
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn set_history(&mut self, lines: usize) {
        self.options.history = lines;
    }

    /// The receiver for the stream started by the latest attach, once.
    pub fn take_stream(&mut self) -> Option<(u64, flume::Receiver<SourceEvent>)> {
        self.stream.take().map(|rx| (self.generation, rx))
    }

    pub fn take_events(&mut self) -> Vec<TerminalEvent> {
        std::mem::take(&mut self.events)
    }

    /// The measured grid. The first call attaches; later calls resize.
    pub fn set_grid(&mut self, size: GridSize) -> Result<(), SourceError> {
        if self.grid == Some(size) {
            return Ok(());
        }
        self.grid = Some(size);
        match self.phase {
            Phase::WaitingForSize => self.attach(),
            Phase::Attached if self.needs_reflow(size.cols) => self.attach(),
            Phase::Attached => {
                self.program_size = None;
                self.resize_emulator(size.cols, size.rows);
                self.source.send(ViewerMessage::Resize(size));
                Ok(())
            }
            Phase::Closed => Ok(()),
        }
    }

    fn needs_reflow(&self, cols: u16) -> bool {
        let Some(attached) = self.attached_cols else {
            return false;
        };
        let on_main = self
            .terminal()
            .is_some_and(|t| matches!(t.active_screen(), Ok(Screen::Primary)));
        let threshold = (attached / 4).max(REFLOW_MIN_COLS);
        self.options.history > 0 && on_main && cols.abs_diff(attached) >= threshold
    }

    /// Detaches and attaches again, replaying the screen and `history` lines.
    pub fn reattach(&mut self) -> Result<(), SourceError> {
        if self.grid.is_none() {
            return Ok(());
        }
        self.attach()
    }

    fn attach(&mut self) -> Result<(), SourceError> {
        let Some(size) = self.grid else {
            return Ok(());
        };
        let request = AttachRequest {
            size,
            history: self.options.history,
            display: self.display_facts(size),
        };
        let emulator = new_emulator(size, &self.options.colors, self.options.scrollback_lines)
            .map_err(|e| SourceError::Attach(format!("emulator: {e}")))?;
        let rx = self.source.attach(&request)?;
        self.terminal = Some(emulator);
        self.stream = Some(rx);
        self.generation += 1;
        self.phase = Phase::Attached;
        self.attached_cols = Some(size.cols);
        self.program_size = None;
        self.attached_on_alt = None;
        if let Some(focused) = self.focused {
            self.send_focus(focused);
        }
        self.events.push(TerminalEvent::Attached);
        Ok(())
    }

    fn display_facts(&self, size: GridSize) -> DisplayFacts {
        let colors = &self.options.colors;
        DisplayFacts {
            foreground: colors.foreground,
            background: colors.background,
            cursor: colors.cursor,
            cell_width: size.cell_width,
            cell_height: size.cell_height,
        }
    }

    /// Handles one event from the stream of `generation`; events from older streams are dropped.
    pub fn handle(&mut self, generation: u64, event: SourceEvent) {
        if generation != self.generation || self.phase != Phase::Attached {
            return;
        }
        match event {
            SourceEvent::Output(bytes) => self.feed(&bytes),
            SourceEvent::SizeChanged { cols, rows } => {
                let ours = self.grid.map(|g| (g.cols, g.rows));
                self.program_size = (ours != Some((cols, rows))).then_some((cols, rows));
                self.resize_emulator(cols, rows);
            }
            SourceEvent::ReattachRequested => {
                if let Err(e) = self.attach() {
                    self.close(CloseReason::Lost(e.to_string()));
                }
            }
            SourceEvent::Closed(reason) => self.close(reason),
        }
    }

    /// The stream ended without a `Closed` event.
    pub fn stream_ended(&mut self, generation: u64) {
        if generation == self.generation && self.phase == Phase::Attached {
            self.close(CloseReason::Lost("stream ended".into()));
        }
    }

    fn close(&mut self, reason: CloseReason) {
        self.phase = Phase::Closed;
        self.events.push(TerminalEvent::Closed(reason));
    }

    fn feed(&mut self, bytes: &[u8]) {
        let Some((terminal, _)) = self.terminal.as_mut() else {
            return;
        };
        let was_alt = matches!(terminal.active_screen(), Ok(Screen::Alternate));
        terminal.vt_write(bytes);
        let is_alt = matches!(terminal.active_screen(), Ok(Screen::Alternate));
        self.flush_effects(false);
        match self.attached_on_alt {
            None => self.attached_on_alt = Some(is_alt),
            Some(true) if was_alt && !is_alt => {
                if let Err(e) = self.attach() {
                    self.close(CloseReason::Lost(e.to_string()));
                }
            }
            Some(_) => {}
        }
    }

    fn resize_emulator(&mut self, cols: u16, rows: u16) {
        let Some(grid) = self.grid else { return };
        let size = GridSize { cols, rows, ..grid };
        if let Some((terminal, effects)) = self.terminal.as_mut() {
            let _ = terminal.resize(cols, rows, grid.cell_width, grid.cell_height);
            effects.set_size(size);
        }
        self.flush_effects(false);
    }

    /// Emulator replies go out as automatic input, except during a paste, which the user typed.
    fn flush_effects(&mut self, user_input: bool) {
        let Some((_, handle)) = self.terminal.as_ref() else {
            return;
        };
        let Effects {
            pty_writes,
            title,
            pwd,
            bell,
        } = handle.take();
        if !pty_writes.is_empty() {
            self.source.send(if user_input {
                ViewerMessage::Input(pty_writes)
            } else {
                ViewerMessage::AutomaticInput(pty_writes)
            });
        }
        if let Some(title) = title {
            self.events.push(TerminalEvent::TitleChanged(title));
        }
        if let Some(pwd) = pwd {
            self.events.push(TerminalEvent::CwdChanged(pwd));
        }
        if bell {
            self.events.push(TerminalEvent::Bell);
        }
    }

    /// User input: snaps to the bottom and, if another viewer had set the size, takes it back.
    pub fn input(&mut self, bytes: &[u8]) {
        if bytes.is_empty() || self.phase != Phase::Attached {
            return;
        }
        self.before_user_input();
        self.source.send(ViewerMessage::Input(bytes.to_vec()));
    }

    fn before_user_input(&mut self) {
        if let Some(terminal) = self.terminal_mut() {
            terminal.scroll_viewport(ScrollViewport::Bottom);
        }
        if self.program_size.take().is_some()
            && let Some(grid) = self.grid
        {
            self.resize_emulator(grid.cols, grid.rows);
            self.source.send(ViewerMessage::Resize(grid));
        }
    }

    pub fn paste(&mut self, text: &str, allow_unsafe: bool) -> PasteOutcome {
        if self.phase != Phase::Attached {
            return PasteOutcome::Empty;
        }
        let Some((terminal, _)) = self.terminal.as_mut() else {
            return PasteOutcome::Empty;
        };
        let mimes = [ClipboardMime::new(b"text/plain")];
        let options = paste::Options::new().with_allow_unsafe(allow_unsafe);
        let result = terminal.paste(options, &mimes, |_, out| out.write_all(text.as_bytes()));
        match result {
            Ok(true) => {
                self.before_user_input();
                self.flush_effects(true);
                PasteOutcome::Sent
            }
            Ok(false) => PasteOutcome::Empty,
            Err(libghostty_vt::Error::Rejected) => {
                self.events
                    .push(TerminalEvent::UnsafePaste(text.to_owned()));
                PasteOutcome::Rejected
            }
            Err(_) => PasteOutcome::Empty,
        }
    }

    pub fn set_focus(&mut self, focused: bool) {
        if self.focused == Some(focused) {
            return;
        }
        self.focused = Some(focused);
        if self.phase == Phase::Attached {
            self.send_focus(focused);
        }
    }

    fn send_focus(&mut self, focused: bool) {
        let report = self
            .terminal()
            .filter(|t| t.mode(Mode::FOCUS_EVENT).unwrap_or(false))
            .and_then(|_| {
                let mut buf = [0u8; 8];
                let event = if focused {
                    focus::Event::Gained
                } else {
                    focus::Event::Lost
                };
                event.encode(&mut buf).ok().map(|n| buf[..n].to_vec())
            });
        self.source.send(ViewerMessage::Focus { focused, report });
    }

    pub fn set_colors(&mut self, colors: TerminalColors) {
        if self.options.colors == colors {
            return;
        }
        self.options.colors = colors;
        if let Some((terminal, _)) = self.terminal.as_mut() {
            let _ = apply_colors(terminal, &self.options.colors);
        }
        if let (Phase::Attached, Some(grid)) = (self.phase, self.grid) {
            let facts = self.display_facts(grid);
            self.source.send(ViewerMessage::Display(facts));
        }
    }

    pub fn colors(&self) -> &TerminalColors {
        &self.options.colors
    }

    pub fn detach(&mut self) {
        if self.phase == Phase::Attached {
            self.source.send(ViewerMessage::Detach);
            self.phase = Phase::Closed;
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::LoopbackHandle;
    use crate::source::LoopbackSource;

    const GRID: GridSize = GridSize {
        cols: 40,
        rows: 10,
        cell_width: 8,
        cell_height: 16,
    };

    fn session() -> (Session, LoopbackHandle) {
        let (source, handle) = LoopbackSource::new();
        let session = Session::new(
            Box::new(source),
            SessionOptions {
                history: 500,
                scrollback_lines: 1000,
                colors: TerminalColors::default(),
            },
        );
        (session, handle)
    }

    fn pump(session: &mut Session, rx: &(u64, flume::Receiver<SourceEvent>)) {
        while let Ok(event) = rx.1.try_recv() {
            session.handle(rx.0, event);
        }
    }

    #[test]
    fn attaches_only_once_the_grid_is_measured() {
        let (mut session, handle) = session();
        assert!(handle.attaches().is_empty());
        session.set_grid(GRID).unwrap();
        let attaches = handle.attaches();
        assert_eq!(attaches.len(), 1);
        assert_eq!(attaches[0].size, GRID);
        assert_eq!(attaches[0].history, 500);
        assert_eq!(attaches[0].display.cell_width, 8);

        let wider = GridSize { cols: 44, ..GRID };
        session.set_grid(wider).unwrap();
        assert_eq!(handle.attaches().len(), 1);
        assert!(handle.take_sent().contains(&ViewerMessage::Resize(wider)));
    }

    #[test]
    fn a_large_width_change_on_the_main_screen_reattaches_to_rewrap_history() {
        let (mut session, handle) = session();
        session.set_grid(GRID).unwrap();
        let rx = session.take_stream().unwrap();
        handle.output(b"$ prompt");
        pump(&mut session, &rx);

        session.set_grid(GridSize { cols: 47, ..GRID }).unwrap();
        assert_eq!(handle.attaches().len(), 1, "7 columns: resize only");

        let wide = GridSize { cols: 80, ..GRID };
        session.set_grid(wide).unwrap();
        let attaches = handle.attaches();
        assert_eq!(attaches.len(), 2);
        assert_eq!(attaches[1].size, wide);
        assert!(!handle.take_sent().contains(&ViewerMessage::Resize(wide)));

        let rx = session.take_stream().unwrap();
        handle.output(b"$ vim");
        handle.output(b"\x1b[?1049h");
        pump(&mut session, &rx);
        session.set_grid(GridSize { cols: 160, ..GRID }).unwrap();
        assert_eq!(
            handle.attaches().len(),
            2,
            "full-screen apps redraw themselves"
        );

        handle.output(b"\x1b[?1049l");
        pump(&mut session, &rx);
        session.set_grid(GridSize { cols: 120, ..GRID }).unwrap();
        assert_eq!(
            handle.attaches().len(),
            3,
            "measured from the attach width, 80"
        );
    }

    #[test]
    fn leaving_the_alternate_screen_after_attaching_on_it_reattaches() {
        let (mut session, handle) = session();
        handle.set_replay(b"\x1b[?1049h\x1b[Hvim screen");
        session.set_grid(GRID).unwrap();
        let rx = session.take_stream().unwrap();
        pump(&mut session, &rx);
        assert_eq!(handle.attaches().len(), 1);

        handle.set_replay(b"$ prompt");
        handle.output(b"\x1b[?1049l");
        pump(&mut session, &rx);
        assert_eq!(handle.attaches().len(), 2);
        let rx2 = session.take_stream().unwrap();
        assert!(rx2.0 > rx.0);
        pump(&mut session, &rx2);

        handle.output(b"\x1b[?1049h\x1b[?1049l");
        pump(&mut session, &rx2);
        assert_eq!(
            handle.attaches().len(),
            2,
            "attached on main screen: no reattach"
        );
    }

    #[test]
    fn stale_streams_are_ignored_and_each_attach_gets_a_fresh_emulator() {
        let (mut session, handle) = session();
        session.set_grid(GRID).unwrap();
        let first = session.take_stream().unwrap();
        handle.output(b"line one\r\n");
        pump(&mut session, &first);
        session.reattach().unwrap();
        let second = session.take_stream().unwrap();
        session.handle(first.0, SourceEvent::Output(b"stale".to_vec()));
        pump(&mut session, &second);
        let t = session.terminal().unwrap();
        assert_eq!(t.cursor_x().unwrap(), 0);
        assert_eq!(t.cursor_y().unwrap(), 0);
    }

    #[test]
    fn emulator_replies_go_out_as_automatic_input() {
        let (mut session, handle) = session();
        session.set_grid(GRID).unwrap();
        let rx = session.take_stream().unwrap();
        handle.take_sent();
        handle.output(b"\x1b[6n");
        pump(&mut session, &rx);
        let sent = handle.take_sent();
        assert!(
            sent.iter()
                .any(|m| matches!(m, ViewerMessage::AutomaticInput(b) if b == b"\x1b[1;1R")),
            "{sent:?}"
        );
    }

    #[test]
    fn paste_is_user_input_and_unsafe_paste_is_held_back() {
        let (mut session, handle) = session();
        session.set_grid(GRID).unwrap();
        let _rx = session.take_stream().unwrap();
        handle.take_sent();
        assert_eq!(session.paste("echo hi", false), PasteOutcome::Sent);
        assert_eq!(handle.take_input(), b"echo hi");

        assert_eq!(session.paste("rm -rf x\n", false), PasteOutcome::Rejected);
        assert!(handle.take_input().is_empty());
        assert_eq!(
            session.take_events().last(),
            Some(&TerminalEvent::UnsafePaste("rm -rf x\n".into()))
        );
        assert_eq!(session.paste("a\nb", true), PasteOutcome::Sent);
        assert_eq!(handle.take_input(), b"a\rb");
    }

    #[test]
    fn bracketed_paste_wraps_text() {
        let (mut session, handle) = session();
        session.set_grid(GRID).unwrap();
        let rx = session.take_stream().unwrap();
        handle.output(b"\x1b[?2004h");
        pump(&mut session, &rx);
        handle.take_sent();
        assert_eq!(session.paste("a\nb", false), PasteOutcome::Sent);
        assert_eq!(handle.take_input(), b"\x1b[200~a\nb\x1b[201~");
    }

    #[test]
    fn title_cwd_bell_and_close_become_events() {
        let (mut session, handle) = session();
        session.set_grid(GRID).unwrap();
        let rx = session.take_stream().unwrap();
        session.take_events();
        handle.output(b"\x1b]2;hello\x07\x1b]7;file:///tmp\x07\x07");
        handle.emit(SourceEvent::Closed(CloseReason::Exited { code: Some(0) }));
        pump(&mut session, &rx);
        let events = session.take_events();
        assert!(events.contains(&TerminalEvent::TitleChanged("hello".into())));
        assert!(events.contains(&TerminalEvent::CwdChanged("file:///tmp".into())));
        assert!(events.contains(&TerminalEvent::Bell));
        assert!(events.contains(&TerminalEvent::Closed(CloseReason::Exited {
            code: Some(0)
        })));
        assert!(session.is_closed());
    }

    #[test]
    fn another_viewers_size_letterboxes_until_we_type() {
        let (mut session, handle) = session();
        session.set_grid(GRID).unwrap();
        let rx = session.take_stream().unwrap();
        handle.emit(SourceEvent::SizeChanged { cols: 20, rows: 5 });
        pump(&mut session, &rx);
        assert!(session.is_letterboxed());
        assert_eq!(session.terminal().unwrap().cols().unwrap(), 20);
        handle.take_sent();
        session.input(b"x");
        assert!(!session.is_letterboxed());
        assert_eq!(session.terminal().unwrap().cols().unwrap(), 40);
        let sent = handle.take_sent();
        assert_eq!(sent[0], ViewerMessage::Resize(GRID));
        assert_eq!(sent[1], ViewerMessage::Input(b"x".to_vec()));
    }

    #[test]
    fn focus_reports_only_when_the_program_asked() {
        let (mut session, handle) = session();
        session.set_grid(GRID).unwrap();
        let rx = session.take_stream().unwrap();
        handle.take_sent();
        session.set_focus(true);
        assert_eq!(
            handle.take_sent(),
            vec![ViewerMessage::Focus {
                focused: true,
                report: None
            }]
        );
        handle.output(b"\x1b[?1004h");
        pump(&mut session, &rx);
        session.set_focus(false);
        assert_eq!(
            handle.take_sent(),
            vec![ViewerMessage::Focus {
                focused: false,
                report: Some(b"\x1b[O".to_vec())
            }]
        );
    }
}
