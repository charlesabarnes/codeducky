//! `terminal.attach`: a viewer's two halves. [`Attachment`] talks to the terminal from any thread;
//! [`AttachOutput`] is read on one thread and grants the core more credit as it hands bytes out,
//! so a viewer that stops reading stops the flow (and later gets a repaint, not a backlog).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::Value;

use crate::client::{ChannelTx, RecvOutcome, StreamRx};
use crate::error::{Error, Result};
use crate::types::{AttachResult, Display};
use crate::wire::{self, Kind};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEvent {
    /// Program bytes for the emulator. The first chunk is a full repaint, starting with CAN.
    Output(Vec<u8>),
    /// Core to observer (`resize_notifications`): the program's grid changed; a repaint follows.
    Resized { cols: u16, rows: u16 },
    /// The stream ended: the program exited or was lost, or we detached. The reason is the core's JSON.
    Closed(Option<Value>),
}

/// Cheap to clone. Detaches when the last clone is dropped, or on [`Attachment::detach`].
#[derive(Clone)]
pub struct Attachment {
    inner: Arc<Inner>,
}

struct Inner {
    tx: ChannelTx,
    info: AttachResult,
    detached: AtomicBool,
}

impl Drop for Inner {
    fn drop(&mut self) {
        if !self.detached.swap(true, Ordering::SeqCst) {
            self.tx.close();
        }
    }
}

pub struct AttachOutput {
    stream: StreamRx,
    done: bool,
}

pub(crate) fn split(info: AttachResult, stream: StreamRx) -> (Attachment, AttachOutput) {
    let attachment = Attachment {
        inner: Arc::new(Inner {
            tx: stream.tx.clone(),
            info,
            detached: AtomicBool::new(false),
        }),
    };
    (
        attachment,
        AttachOutput {
            stream,
            done: false,
        },
    )
}

impl Attachment {
    pub fn info(&self) -> &AttachResult {
        &self.inner.info
    }

    pub fn channel(&self) -> u32 {
        self.inner.tx.channel
    }

    fn send(&self, kind: Kind, payload: &[u8]) -> Result<()> {
        if self.inner.detached.load(Ordering::SeqCst) {
            return Err(Error::Disconnected);
        }
        self.inner.tx.send(kind, payload)
    }

    /// Keys and paste, already encoded for the terminal. Counts as human activity.
    pub fn input(&self, bytes: &[u8]) -> Result<()> {
        self.send(Kind::Data, bytes)
    }

    /// Replies our own emulator produced (`on_pty_write`). Not human activity; on a core without
    /// the feature they go as plain input.
    pub fn automatic_input(&self, bytes: &[u8]) -> Result<()> {
        let kind = if self.inner.info.automatic_input {
            Kind::AutomaticInput
        } else {
            Kind::Data
        };
        self.send(kind, bytes)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.send(Kind::Resize, &wire::size_payload(cols, rows))
    }

    /// Send on window activation so this viewer becomes the active one.
    pub fn focus(&self, focused: bool) -> Result<()> {
        self.send(Kind::Focus, &[u8::from(focused)])
    }

    /// Colors and cell size the core answers the program's display queries with.
    pub fn facts(&self, display: &Display) -> Result<()> {
        let json = serde_json::to_vec(display).map_err(|e| Error::Protocol(e.to_string()))?;
        self.send(Kind::Facts, &json)
    }

    /// An empty CLOSE; the output side then ends with `Closed`.
    pub fn detach(&self) {
        if !self.inner.detached.swap(true, Ordering::SeqCst) {
            self.inner.tx.close();
        }
    }
}

impl AttachOutput {
    /// Blocks for the next event. `Err(Disconnected)` after `Closed`, or when the connection drops.
    pub fn recv(&mut self) -> Result<StreamEvent> {
        loop {
            if self.done {
                return Err(Error::Disconnected);
            }
            match self.stream.recv(None) {
                RecvOutcome::Frame(frame) => {
                    if let Some(event) = self.take(frame.kind, frame.payload) {
                        return Ok(event);
                    }
                }
                RecvOutcome::Timeout => {}
                RecvOutcome::Gone => return Err(Error::Disconnected),
            }
        }
    }

    /// `Ok(None)` when nothing arrived within `timeout`.
    pub fn recv_timeout(&mut self, timeout: Duration) -> Result<Option<StreamEvent>> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            if self.done {
                return Err(Error::Disconnected);
            }
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match self.stream.recv(Some(left)) {
                RecvOutcome::Frame(frame) => {
                    if let Some(event) = self.take(frame.kind, frame.payload) {
                        return Ok(Some(event));
                    }
                }
                RecvOutcome::Timeout => return Ok(None),
                RecvOutcome::Gone => return Err(Error::Disconnected),
            }
        }
    }

    /// Never blocks; `Ok(None)` when nothing is waiting.
    pub fn try_recv(&mut self) -> Result<Option<StreamEvent>> {
        loop {
            if self.done {
                return Err(Error::Disconnected);
            }
            match self.stream.try_recv() {
                RecvOutcome::Frame(frame) => {
                    if let Some(event) = self.take(frame.kind, frame.payload) {
                        return Ok(Some(event));
                    }
                }
                RecvOutcome::Timeout => return Ok(None),
                RecvOutcome::Gone => return Err(Error::Disconnected),
            }
        }
    }

    fn take(&mut self, kind: u8, payload: Vec<u8>) -> Option<StreamEvent> {
        match Kind::from_u8(kind)? {
            Kind::Data => {
                self.stream.tx.credit(payload.len());
                Some(StreamEvent::Output(payload))
            }
            Kind::Resize => {
                let (cols, rows) = wire::parse_size(&payload)?;
                Some(StreamEvent::Resized { cols, rows })
            }
            Kind::Close => {
                self.done = true;
                Some(StreamEvent::Closed(serde_json::from_slice(&payload).ok()))
            }
            _ => None,
        }
    }
}
