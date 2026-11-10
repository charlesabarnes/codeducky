//! One framed connection to a core: calls on channel 0, streams on their own channels.
//!
//! Threading: a single reader thread owns the read half and routes each frame. Replies go to the
//! waiting caller through a one-shot channel; stream frames go to the stream's receiver, which
//! lives with whoever consumes it (`Subscription`, `AttachOutput`). Writes are whole frames under a
//! mutex, so any thread may call, type or credit at any time.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::error::{Error, Result, RpcError};
use crate::socket::{SocketEnv, discover};
use crate::types::HelloResult;
use crate::wire::{self, CONTROL, Frame, Kind};

pub const GENERATION: u32 = 1;
/// Frames held for a channel whose opening reply has not been routed yet.
const MAX_ORPHANS: usize = 4096;

/// Cheap to clone; the connection closes when the last clone, stream or handle is dropped.
#[derive(Clone)]
pub struct Client {
    shared: Arc<Shared>,
}

struct Shared {
    writer: Mutex<UnixStream>,
    routes: Arc<Mutex<Routes>>,
    next_id: AtomicU64,
    hello: HelloResult,
}

impl Drop for Shared {
    fn drop(&mut self) {
        let _ = lock(&self.writer).shutdown(Shutdown::Both);
    }
}

#[derive(Default)]
struct Routes {
    alive: bool,
    pending: HashMap<u64, Pending>,
    streams: HashMap<u32, Sender<Frame>>,
    orphans: HashMap<u32, Vec<Frame>>,
}

struct Pending {
    reply: SyncSender<Result<Value>>,
    /// Installed for the reply's `result.channel` before any later frame is routed.
    opens: Option<Sender<Frame>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Client {
    /// The socket `hc` itself would use (see [`crate::socket`]).
    pub fn connect_default() -> Result<Self> {
        Self::connect(discover(&SocketEnv::from_process()))
    }

    /// Never starts a core: a missing socket is [`Error::NotRunning`].
    pub fn connect(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let stream = UnixStream::connect(path).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused => {
                Error::NotRunning(path.display().to_string())
            }
            _ => Error::Io(error),
        })?;
        Self::over(stream)
    }

    /// Says hello on an already connected stream and switches it to framed mode.
    pub fn over(stream: UnixStream) -> Result<Self> {
        let mut writer = stream.try_clone()?;
        let hello = json!({
            "jsonrpc": "2.0", "id": 0, "method": "hello",
            "params": {"framed": true, "generation": GENERATION},
        });
        writer.write_all(format!("{hello}\n").as_bytes())?;
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Err(Error::Disconnected);
        }
        let reply: Value = serde_json::from_str(&line)
            .map_err(|error| Error::Protocol(format!("hello reply: {error}")))?;
        let hello: HelloResult = decode_reply(reply)?;
        if !hello.framed {
            return Err(Error::Protocol(
                "the core did not switch to framed mode".into(),
            ));
        }
        let routes = Arc::new(Mutex::new(Routes {
            alive: true,
            ..Routes::default()
        }));
        let reader_routes = routes.clone();
        thread::Builder::new()
            .name("ducky-hc-reader".into())
            .spawn(move || read_loop(reader, &reader_routes))?;
        Ok(Self {
            shared: Arc::new(Shared {
                writer: Mutex::new(writer),
                routes,
                next_id: AtomicU64::new(1),
                hello,
            }),
        })
    }

    pub fn hello(&self) -> &HelloResult {
        &self.shared.hello
    }

    pub fn is_connected(&self) -> bool {
        lock(&self.shared.routes).alive
    }

    /// Waits for the reply however long it takes (an exec may run 600 s), or until the line drops.
    pub fn call<P: Serialize, R: DeserializeOwned>(&self, method: &str, params: P) -> Result<R> {
        let reply = self.request(method, to_params(params)?, None, None)?;
        decode(reply)
    }

    /// Gives up after `timeout`; an exec given up on is cancelled on the core.
    pub fn call_timeout<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &str,
        params: P,
        timeout: Duration,
    ) -> Result<R> {
        let reply = self.request(method, to_params(params)?, None, Some(timeout))?;
        decode(reply)
    }

    /// A call whose reply carries `result.channel`: frames on it go to the returned receiver.
    pub(crate) fn open<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &str,
        params: P,
    ) -> Result<(R, StreamRx)> {
        let (tx, rx) = mpsc::channel();
        let reply = self.request(method, to_params(params)?, Some(tx), None)?;
        let channel = reply["channel"]
            .as_u64()
            .and_then(|c| u32::try_from(c).ok())
            .ok_or_else(|| Error::Protocol(format!("{method} reply has no channel")))?;
        let stream = StreamRx {
            tx: ChannelTx {
                client: self.clone(),
                channel,
            },
            rx,
        };
        Ok((decode(reply)?, stream))
    }

    fn request(
        &self,
        method: &str,
        params: Value,
        opens: Option<Sender<Frame>>,
        timeout: Option<Duration>,
    ) -> Result<Value> {
        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        let (reply, replied) = mpsc::sync_channel(1);
        {
            let mut routes = lock(&self.shared.routes);
            if !routes.alive {
                return Err(Error::Disconnected);
            }
            routes.pending.insert(id, Pending { reply, opens });
        }
        let message = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        if let Err(error) = self.send(CONTROL, Kind::Data, message.to_string().as_bytes()) {
            lock(&self.shared.routes).pending.remove(&id);
            return Err(error);
        }
        let outcome = match timeout {
            None => replied.recv().map_err(|_| Error::Disconnected),
            Some(timeout) => match replied.recv_timeout(timeout) {
                Ok(outcome) => Ok(outcome),
                Err(RecvTimeoutError::Disconnected) => Err(Error::Disconnected),
                Err(RecvTimeoutError::Timeout) => {
                    lock(&self.shared.routes).pending.remove(&id);
                    let cancel = json!({"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": id}});
                    let _ = self.send(CONTROL, Kind::Data, cancel.to_string().as_bytes());
                    Err(Error::Timeout)
                }
            },
        };
        outcome?
    }

    pub(crate) fn send(&self, channel: u32, kind: Kind, payload: &[u8]) -> Result<()> {
        let frame = wire::encode(channel, kind, payload);
        lock(&self.shared.writer)
            .write_all(&frame)
            .map_err(|_| Error::Disconnected)
    }
}

fn to_params<P: Serialize>(params: P) -> Result<Value> {
    serde_json::to_value(params).map_err(|error| Error::Protocol(error.to_string()))
}

fn decode<R: DeserializeOwned>(result: Value) -> Result<R> {
    serde_json::from_value(result).map_err(|error| Error::Protocol(format!("reply: {error}")))
}

fn decode_reply<R: DeserializeOwned>(mut reply: Value) -> Result<R> {
    if let Some(error) = reply.get("error") {
        return Err(RpcError::from_json(error).into());
    }
    decode(reply["result"].take())
}

fn read_loop(mut reader: BufReader<UnixStream>, routes: &Mutex<Routes>) {
    while let Ok(Some(frame)) = wire::read_frame(&mut reader) {
        if frame.channel == CONTROL {
            if frame.kind == Kind::Data as u8 {
                route_reply(routes, &frame.payload);
            }
        } else {
            route_stream(routes, frame);
        }
    }
    let mut routes = lock(routes);
    routes.alive = false;
    for (_, pending) in routes.pending.drain() {
        let _ = pending.reply.send(Err(Error::Disconnected));
    }
    routes.streams.clear();
    routes.orphans.clear();
}

fn route_reply(routes: &Mutex<Routes>, payload: &[u8]) {
    let Ok(mut message) = serde_json::from_slice::<Value>(payload) else {
        return;
    };
    if message.get("method").is_some() {
        return;
    }
    let Some(id) = message["id"].as_u64() else {
        return;
    };
    let mut routes = lock(routes);
    let Some(pending) = routes.pending.remove(&id) else {
        return;
    };
    let outcome = match message.get("error") {
        Some(error) => Err(RpcError::from_json(error).into()),
        None => Ok(message["result"].take()),
    };
    if let (Ok(result), Some(tx)) = (&outcome, pending.opens)
        && let Some(channel) = result["channel"]
            .as_u64()
            .and_then(|c| u32::try_from(c).ok())
    {
        for frame in routes.orphans.remove(&channel).unwrap_or_default() {
            let _ = tx.send(frame);
        }
        routes.streams.insert(channel, tx);
    }
    let _ = pending.reply.send(outcome);
}

fn route_stream(routes: &Mutex<Routes>, frame: Frame) {
    let mut routes = lock(routes);
    let channel = frame.channel;
    let closing = frame.kind == Kind::Close as u8;
    match routes.streams.get(&channel) {
        Some(tx) => {
            if tx.send(frame).is_err() || closing {
                routes.streams.remove(&channel);
            }
        }
        None if !closing => {
            let held = routes.orphans.entry(channel).or_default();
            if held.len() < MAX_ORPHANS {
                held.push(frame);
            }
        }
        None => {
            routes.orphans.remove(&channel);
        }
    }
}

/// Sends on one channel: credit, close, and a viewer's frames.
#[derive(Clone)]
pub(crate) struct ChannelTx {
    pub client: Client,
    pub channel: u32,
}

impl ChannelTx {
    pub fn send(&self, kind: Kind, payload: &[u8]) -> Result<()> {
        self.client.send(self.channel, kind, payload)
    }

    pub fn credit(&self, bytes: usize) {
        if bytes > 0 {
            let bytes = u32::try_from(bytes).unwrap_or(u32::MAX);
            let _ = self.send(Kind::Credit, &bytes.to_le_bytes());
        }
    }

    pub fn close(&self) {
        let _ = self.send(Kind::Close, &[]);
    }
}

/// The receiving end of one channel, with the means to answer on it.
pub(crate) struct StreamRx {
    pub tx: ChannelTx,
    pub rx: Receiver<Frame>,
}

impl StreamRx {
    pub fn recv(&self, timeout: Option<Duration>) -> RecvOutcome {
        let received = match timeout {
            None => self.rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
            Some(timeout) => self.rx.recv_timeout(timeout),
        };
        match received {
            Ok(frame) => RecvOutcome::Frame(frame),
            Err(RecvTimeoutError::Timeout) => RecvOutcome::Timeout,
            Err(RecvTimeoutError::Disconnected) => RecvOutcome::Gone,
        }
    }

    pub fn try_recv(&self) -> RecvOutcome {
        match self.rx.try_recv() {
            Ok(frame) => RecvOutcome::Frame(frame),
            Err(mpsc::TryRecvError::Empty) => RecvOutcome::Timeout,
            Err(mpsc::TryRecvError::Disconnected) => RecvOutcome::Gone,
        }
    }
}

pub(crate) enum RecvOutcome {
    Frame(Frame),
    Timeout,
    /// The channel was closed earlier, or the connection dropped.
    Gone,
}
