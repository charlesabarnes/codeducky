//! An in-memory source: tests push program output through a [`LoopbackHandle`] and read back
//! everything the viewer sent.

use std::sync::{Arc, Mutex};

use super::{AttachRequest, SourceError, SourceEvent, TerminalSource, ViewerMessage};

#[derive(Default)]
struct Shared {
    attaches: Vec<AttachRequest>,
    sent: Vec<ViewerMessage>,
    stream: Option<flume::Sender<SourceEvent>>,
    replay: Vec<u8>,
}

pub struct LoopbackSource {
    shared: Arc<Mutex<Shared>>,
}

#[derive(Clone)]
pub struct LoopbackHandle {
    shared: Arc<Mutex<Shared>>,
}

impl LoopbackSource {
    pub fn new() -> (Self, LoopbackHandle) {
        let shared = Arc::new(Mutex::new(Shared::default()));
        (
            Self {
                shared: shared.clone(),
            },
            LoopbackHandle { shared },
        )
    }
}

impl TerminalSource for LoopbackSource {
    fn attach(
        &mut self,
        request: &AttachRequest,
    ) -> Result<flume::Receiver<SourceEvent>, SourceError> {
        let (tx, rx) = flume::unbounded();
        let mut shared = lock(&self.shared);
        if !shared.replay.is_empty() {
            let _ = tx.send(SourceEvent::Output(shared.replay.clone()));
        }
        shared.attaches.push(*request);
        shared.stream = Some(tx);
        Ok(rx)
    }

    fn send(&mut self, message: ViewerMessage) {
        lock(&self.shared).sent.push(message);
    }
}

impl LoopbackHandle {
    /// Sends `event` on the current stream; returns false when nothing is attached.
    pub fn emit(&self, event: SourceEvent) -> bool {
        lock(&self.shared)
            .stream
            .as_ref()
            .is_some_and(|tx| tx.send(event).is_ok())
    }

    pub fn output(&self, bytes: &[u8]) -> bool {
        self.emit(SourceEvent::Output(bytes.to_vec()))
    }

    /// Bytes sent as the first output of every later attach, like hc's repaint.
    pub fn set_replay(&self, bytes: &[u8]) {
        lock(&self.shared).replay = bytes.to_vec();
    }

    pub fn attaches(&self) -> Vec<AttachRequest> {
        lock(&self.shared).attaches.clone()
    }

    pub fn take_sent(&self) -> Vec<ViewerMessage> {
        std::mem::take(&mut lock(&self.shared).sent)
    }

    /// All `Input` bytes sent so far, concatenated, leaving other messages in place.
    pub fn take_input(&self) -> Vec<u8> {
        let mut shared = lock(&self.shared);
        let mut out = Vec::new();
        shared.sent.retain(|m| match m {
            ViewerMessage::Input(bytes) => {
                out.extend_from_slice(bytes);
                false
            }
            _ => true,
        });
        out
    }
}

fn lock(shared: &Mutex<Shared>) -> std::sync::MutexGuard<'_, Shared> {
    shared.lock().unwrap_or_else(|e| e.into_inner())
}
