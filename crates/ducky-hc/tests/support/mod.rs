//! A scripted stand-in for herdr-core on a temporary Unix socket.

#![allow(dead_code)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::thread::{self, JoinHandle};

use ducky_hc::wire::{self, Frame, Kind};
use serde_json::{Value, json};

pub struct FakeCore {
    pub path: PathBuf,
    _dir: tempfile::TempDir,
    handle: Option<JoinHandle<()>>,
}

impl FakeCore {
    /// Accepts one connection, answers `hello`, then hands the framed line to `script`.
    pub fn start(script: impl FnOnce(&mut Peer) + Send + 'static) -> Self {
        let dir = tempfile::Builder::new()
            .prefix("dhc")
            .tempdir_in("/tmp")
            .unwrap();
        let path = dir.path().join("core.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let handle = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut peer = Peer::handshake(stream);
            script(&mut peer);
        });
        Self {
            path,
            _dir: dir,
            handle: Some(handle),
        }
    }

    /// Waits for the script; its assertion failures fail the test here.
    pub fn finish(mut self) {
        if let Some(handle) = self.handle.take() {
            handle.join().expect("fake core script failed");
        }
    }
}

pub struct Peer {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Peer {
    fn handshake(stream: UnixStream) -> Self {
        let writer = stream.try_clone().unwrap();
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let hello: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(hello["method"], "hello");
        assert_eq!(hello["params"]["framed"], true);
        let mut peer = Self { reader, writer };
        let reply = json!({"jsonrpc": "2.0", "id": hello["id"], "result": {
            "generation": 1, "version": "0.1.19", "core": {"id": "c1", "name": "fake"},
            "framed": true, "methods": [], "features": ["framed", "attach", "automatic_input"],
        }});
        peer.writer
            .write_all(format!("{reply}\n").as_bytes())
            .unwrap();
        peer
    }

    pub fn frame(&mut self) -> Option<Frame> {
        wire::read_frame(&mut self.reader).unwrap()
    }

    /// The next frame on channel 0, as JSON.
    pub fn request(&mut self) -> Value {
        loop {
            let frame = self.frame().expect("a request");
            if frame.channel == 0 {
                return serde_json::from_slice(&frame.payload).unwrap();
            }
        }
    }

    /// Skips CREDIT frames, which arrive whenever the client consumes.
    pub fn next_non_credit(&mut self) -> Frame {
        loop {
            let frame = self.frame().expect("a frame");
            if frame.kind != Kind::Credit as u8 {
                return frame;
            }
        }
    }

    pub fn send(&mut self, channel: u32, kind: Kind, payload: &[u8]) {
        self.writer
            .write_all(&wire::encode(channel, kind, payload))
            .unwrap();
    }

    pub fn raw(&mut self, bytes: &[u8]) {
        self.writer.write_all(bytes).unwrap();
    }

    pub fn reply(&mut self, id: &Value, result: Value) {
        let message = json!({"jsonrpc": "2.0", "id": id, "result": result});
        self.send(0, Kind::Data, message.to_string().as_bytes());
    }

    pub fn error(&mut self, id: &Value, kind: &str, message: &str) {
        let message = json!({"jsonrpc": "2.0", "id": id, "error": {
            "code": -32000, "message": message, "data": {"kind": kind, "hint": "try again"},
        }});
        self.send(0, Kind::Data, message.to_string().as_bytes());
    }
}

pub fn terminal(address: &str) -> Value {
    json!({
        "address": address, "argv": ["sh"], "cwd": "/", "state": "running", "labels": {},
        "created_ms": 1, "cols": 80, "rows": 24, "screen": "",
    })
}

pub fn exec_result(stdout: &[u8], code: i32) -> Value {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD;
    json!({"code": code, "signal": null, "stdout": b64.encode(stdout), "stderr": "",
        "truncated": false, "timed_out": false, "ms": 1})
}
