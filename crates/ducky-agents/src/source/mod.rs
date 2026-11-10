//! [`HcTerminalSource`]: a `ducky_terminal` source over herdr-core's `terminal.attach`.
//!
//! Each attach runs two threads: one moves the attach stream's output to the view (crediting
//! the core as it goes, in ducky-hc), the other watches the terminal's events for what the stream
//! does not carry: another viewer taking over the size, and a kept terminal coming back after
//! its program was lost.

pub(crate) mod convert;
mod sizes;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use ducky_hc::{
    AttachOutput, Attachment, Client, EventKind, EventMessage, StreamEvent, SubscribeParams,
    Subscription,
};
use ducky_terminal::source::{
    AttachRequest, CloseReason, DisplayFacts, SourceError, SourceEvent, TerminalSource,
    ViewerMessage,
};

use convert::Ending;
use sizes::{OwnSizes, SizeEcho};

/// How often the event thread checks whether its stream was detached.
const POLL: Duration = Duration::from_millis(250);

pub struct HcTerminalSource {
    client: Client,
    terminal: String,
    active: Option<Active>,
}

struct Active {
    attachment: Attachment,
    shared: Arc<Shared>,
    display: DisplayFacts,
}

#[derive(Default)]
struct Shared {
    detached: AtomicBool,
    /// A kept terminal lost its program; the event thread waits for `restarted`.
    awaiting_restart: AtomicBool,
    sizes: Mutex<OwnSizes>,
}

impl Shared {
    fn sizes(&self) -> MutexGuard<'_, OwnSizes> {
        self.sizes.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn detached(&self) -> bool {
        self.detached.load(Ordering::SeqCst)
    }
}

impl HcTerminalSource {
    /// `terminal` is an address (`t7`, `machine/t7`) or a name.
    pub fn new(client: Client, terminal: impl Into<String>) -> Self {
        Self {
            client,
            terminal: terminal.into(),
            active: None,
        }
    }

    pub fn terminal(&self) -> &str {
        &self.terminal
    }

    fn stop(&mut self) {
        if let Some(active) = self.active.take() {
            active.shared.detached.store(true, Ordering::SeqCst);
            active.attachment.detach();
        }
    }

    fn resize(active: &mut Active, size: ducky_terminal::source::GridSize) {
        active.shared.sizes().sent(size.cols, size.rows);
        let _ = active.attachment.resize(size.cols, size.rows);
        let cell = (size.cell_width, size.cell_height);
        if cell != (active.display.cell_width, active.display.cell_height) {
            active.display.cell_width = cell.0;
            active.display.cell_height = cell.1;
            let _ = active.attachment.facts(&convert::cell(cell.0, cell.1));
        }
    }
}

impl TerminalSource for HcTerminalSource {
    fn attach(
        &mut self,
        request: &AttachRequest,
    ) -> Result<flume::Receiver<SourceEvent>, SourceError> {
        self.stop();
        let fail = |error: ducky_hc::Error| SourceError::Attach(error.to_string());
        let events = self
            .client
            .subscribe(&SubscribeParams {
                terminal: Some(self.terminal.clone()),
                ..SubscribeParams::default()
            })
            .map_err(fail)?;
        let params = convert::attach_params(&self.terminal, request);
        let (attachment, output) = self.client.attach(&params).map_err(fail)?;
        let keep = attachment.info().terminal.keep;
        let shared = Arc::new(Shared::default());
        shared.sizes().sent(request.size.cols, request.size.rows);
        let (tx, rx) = flume::unbounded();
        spawn("ducky-agents-attach", {
            let (tx, shared) = (tx.clone(), shared.clone());
            move || pump_output(output, &tx, &shared, keep)
        })?;
        spawn("ducky-agents-watch", {
            let shared = shared.clone();
            move || watch_events(events, &tx, &shared)
        })?;
        self.active = Some(Active {
            attachment,
            shared,
            display: request.display,
        });
        Ok(rx)
    }

    fn send(&mut self, message: ViewerMessage) {
        if matches!(message, ViewerMessage::Detach) {
            self.stop();
            return;
        }
        let Some(mut active) = self.active.take() else {
            return;
        };
        let attachment = &active.attachment;
        match message {
            ViewerMessage::Input(bytes) => {
                let _ = attachment.input(&bytes);
            }
            ViewerMessage::AutomaticInput(bytes) => {
                let _ = attachment.automatic_input(&bytes);
            }
            ViewerMessage::Resize(size) => Self::resize(&mut active, size),
            ViewerMessage::Focus { focused, .. } => {
                let _ = attachment.focus(focused);
            }
            ViewerMessage::Display(facts) => {
                active.display = facts;
                let _ = attachment.facts(&convert::display(&facts));
            }
            ViewerMessage::Detach => {}
        }
        self.active = Some(active);
    }
}

impl Drop for HcTerminalSource {
    fn drop(&mut self) {
        self.stop();
    }
}

fn spawn(name: &str, body: impl FnOnce() + Send + 'static) -> Result<(), SourceError> {
    thread::Builder::new()
        .name(name.into())
        .spawn(body)
        .map(drop)
        .map_err(SourceError::Io)
}

fn pump_output(
    mut output: AttachOutput,
    tx: &flume::Sender<SourceEvent>,
    shared: &Shared,
    keep: bool,
) {
    loop {
        let event = match output.recv() {
            Ok(StreamEvent::Output(bytes)) => SourceEvent::Output(bytes),
            Ok(StreamEvent::Resized { cols, rows }) => SourceEvent::SizeChanged { cols, rows },
            Ok(StreamEvent::Closed(reason)) => {
                if shared.detached() {
                    return;
                }
                match convert::ending(reason.as_ref()) {
                    Ending::Lost(_) if keep => {
                        shared.awaiting_restart.store(true, Ordering::SeqCst);
                        return;
                    }
                    ending => SourceEvent::Closed(ending.close_reason()),
                }
            }
            Err(_) => {
                if !shared.detached() {
                    let lost = CloseReason::Lost("the connection to herdr-core closed".into());
                    let _ = tx.send(SourceEvent::Closed(lost));
                }
                return;
            }
        };
        let last = matches!(event, SourceEvent::Closed(_));
        if tx.send(event).is_err() || last {
            return;
        }
    }
}

fn watch_events(mut events: Subscription, tx: &flume::Sender<SourceEvent>, shared: &Shared) {
    while !shared.detached() {
        let event = match events.recv_timeout(POLL) {
            Ok(Some(EventMessage::Event(event))) => event,
            Ok(Some(EventMessage::Missed(snapshot))) => {
                if let Some(terminal) = snapshot.terminals.first() {
                    forward_size(tx, shared, terminal.cols, terminal.rows);
                }
                continue;
            }
            Ok(Some(EventMessage::Closed(_))) | Err(_) => return,
            Ok(_) => continue,
        };
        match event.kind {
            EventKind::Size => {
                let size = |key: &str| event.data[key].as_u64().and_then(|n| u16::try_from(n).ok());
                if let (Some(cols), Some(rows)) = (size("cols"), size("rows")) {
                    forward_size(tx, shared, cols, rows);
                }
            }
            EventKind::Restarted => {
                shared.awaiting_restart.store(false, Ordering::SeqCst);
                let _ = tx.send(SourceEvent::ReattachRequested);
            }
            EventKind::Finished | EventKind::Removed
                if shared.awaiting_restart.load(Ordering::SeqCst) =>
            {
                let lost = CloseReason::Lost("the program was lost and did not come back".into());
                let _ = tx.send(SourceEvent::Closed(lost));
                return;
            }
            _ => {}
        }
    }
}

fn forward_size(tx: &flume::Sender<SourceEvent>, shared: &Shared, cols: u16, rows: u16) {
    if shared.sizes().classify(cols, rows) != SizeEcho::Stale {
        let _ = tx.send(SourceEvent::SizeChanged { cols, rows });
    }
}
