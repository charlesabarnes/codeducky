//! `events.subscribe` on its own framed channel: JSON lines, credited as they are handed out.

use std::collections::VecDeque;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use crate::client::{RecvOutcome, StreamRx};
use crate::error::{Error, Result};
use crate::types::{Snapshot, Terminal};
use crate::wire::Kind;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventKind {
    Created,
    Lost,
    Restarted,
    Keep,
    Finished,
    Removed,
    Status,
    Turn,
    Title,
    Labels,
    Size,
    Doc,
    Foreground,
    Other(String),
}

impl From<&str> for EventKind {
    fn from(kind: &str) -> Self {
        match kind {
            "created" => Self::Created,
            "lost" => Self::Lost,
            "restarted" => Self::Restarted,
            "keep" => Self::Keep,
            "finished" => Self::Finished,
            "removed" => Self::Removed,
            "status" => Self::Status,
            "turn" => Self::Turn,
            "title" => Self::Title,
            "labels" => Self::Labels,
            "size" => Self::Size,
            "doc" => Self::Doc,
            "foreground" => Self::Foreground,
            other => Self::Other(other.to_owned()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Event {
    pub seq: u64,
    pub kind: EventKind,
    /// The terminal's address; `None` for document events.
    pub terminal: Option<String>,
    /// Set for document events from another machine.
    pub machine: Option<String>,
    pub data: Value,
}

impl Event {
    /// The full record, sent when a change brings a terminal into the subscription's filter
    /// (and with `created`).
    pub fn record(&self) -> Option<Terminal> {
        serde_json::from_value(self.data.get("record")?.clone()).ok()
    }
}

#[derive(Debug, Clone)]
pub enum EventMessage {
    Event(Event),
    /// Every 15 s while nothing else is said.
    Heartbeat {
        seq: u64,
    },
    /// The subscriber fell behind and events were dropped: replace all state with this snapshot.
    Missed(Snapshot),
    /// The core ended the subscription; the reason is its JSON, if any.
    Closed(Option<Value>),
}

/// Single consumer: move it to the thread that handles events. Dropping it unsubscribes.
pub struct Subscription {
    snapshot: Snapshot,
    stream: StreamRx,
    partial: Vec<u8>,
    queued: VecDeque<Queued>,
    /// After a `missed` snapshot, events at or below its sequence are already in it.
    floor: u64,
    closed: bool,
}

#[derive(Deserialize)]
struct Notification {
    method: String,
    #[serde(default)]
    params: Value,
}

impl Subscription {
    pub(crate) fn new(snapshot: Snapshot, stream: StreamRx) -> Self {
        Self {
            floor: snapshot.seq,
            snapshot,
            stream,
            partial: Vec::new(),
            queued: VecDeque::new(),
            closed: false,
        }
    }

    /// The terminals that matched when subscribing; events after its `seq` follow.
    pub fn snapshot(&self) -> &Snapshot {
        &self.snapshot
    }

    /// Blocks for the next message. `Err(Disconnected)` once the subscription or connection is over.
    pub fn recv(&mut self) -> Result<EventMessage> {
        loop {
            if let Some(message) = self.next_line()? {
                return Ok(message);
            }
            if self.closed {
                return Err(Error::Disconnected);
            }
            match self.stream.recv(None) {
                RecvOutcome::Frame(frame) => self.take(frame.kind, frame.payload),
                RecvOutcome::Timeout => {}
                RecvOutcome::Gone => return Err(Error::Disconnected),
            }
        }
    }

    /// `Ok(None)` when nothing arrived within `timeout`.
    pub fn recv_timeout(&mut self, timeout: Duration) -> Result<Option<EventMessage>> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            if let Some(message) = self.next_line()? {
                return Ok(Some(message));
            }
            if self.closed {
                return Err(Error::Disconnected);
            }
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match self.stream.recv(Some(left)) {
                RecvOutcome::Frame(frame) => self.take(frame.kind, frame.payload),
                RecvOutcome::Timeout => return Ok(None),
                RecvOutcome::Gone => return Err(Error::Disconnected),
            }
        }
    }

    fn take(&mut self, kind: u8, payload: Vec<u8>) {
        match Kind::from_u8(kind) {
            Some(Kind::Data) => {
                self.partial.extend_from_slice(&payload);
                while let Some(at) = self.partial.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = self.partial.drain(..=at).collect();
                    self.queued.push_back(Queued::Line(line));
                }
            }
            Some(Kind::Close) => {
                self.closed = true;
                let reason = serde_json::from_slice(&payload).ok();
                self.queued.push_back(Queued::Closed(reason));
            }
            _ => {}
        }
    }

    fn next_line(&mut self) -> Result<Option<EventMessage>> {
        while let Some(queued) = self.queued.pop_front() {
            let line = match queued {
                Queued::Line(line) => line,
                Queued::Closed(reason) => return Ok(Some(EventMessage::Closed(reason))),
            };
            self.stream.tx.credit(line.len());
            if let Some(message) = self.parse(&line)? {
                return Ok(Some(message));
            }
        }
        Ok(None)
    }

    fn parse(&mut self, line: &[u8]) -> Result<Option<EventMessage>> {
        if line.iter().all(u8::is_ascii_whitespace) {
            return Ok(None);
        }
        let note: Notification = serde_json::from_slice(line)
            .map_err(|error| Error::Protocol(format!("event line: {error}")))?;
        let params = note.params;
        Ok(match note.method.as_str() {
            "event" => {
                let seq = params["seq"].as_u64().unwrap_or(0);
                if seq <= self.floor {
                    return Ok(None);
                }
                self.floor = seq;
                Some(EventMessage::Event(Event {
                    seq,
                    kind: EventKind::from(params["type"].as_str().unwrap_or_default()),
                    terminal: params["terminal"].as_str().map(str::to_owned),
                    machine: params["machine"].as_str().map(str::to_owned),
                    data: params["data"].clone(),
                }))
            }
            "heartbeat" => Some(EventMessage::Heartbeat {
                seq: params["seq"].as_u64().unwrap_or(0),
            }),
            "missed" => {
                let snapshot: Snapshot = serde_json::from_value(params)
                    .map_err(|error| Error::Protocol(format!("missed snapshot: {error}")))?;
                self.floor = snapshot.seq;
                Some(EventMessage::Missed(snapshot))
            }
            _ => None,
        })
    }
}

enum Queued {
    Line(Vec<u8>),
    Closed(Option<Value>),
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if !self.closed {
            self.stream.tx.close();
        }
    }
}
