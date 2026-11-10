//! An in-process fake GitHub: a std TcpListener speaking just enough HTTP/1.1, answering from a
//! handler and recording every request.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::{Client, Token};
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct Call {
    pub method: String,
    pub path: String,
    /// The raw query string, without `?`.
    pub search: String,
    pub query: HashMap<String, String>,
    pub headers: HashMap<String, String>,
    pub body: Value,
}

impl Call {
    pub fn variables(&self) -> &Value {
        &self.body["variables"]
    }

    pub fn graphql(&self) -> &str {
        self.body["query"].as_str().unwrap_or_default()
    }
}

#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub body: String,
    pub headers: Vec<(String, String)>,
}

impl Reply {
    pub fn json(body: Value) -> Self {
        Self {
            status: 200,
            body: body.to_string(),
            headers: Vec::new(),
        }
    }

    pub fn raw(body: &str) -> Self {
        Self {
            status: 200,
            body: body.to_owned(),
            headers: Vec::new(),
        }
    }

    pub fn status(mut self, status: u16) -> Self {
        self.status = status;
        self
    }

    pub fn header(mut self, name: &str, value: impl Into<String>) -> Self {
        self.headers.push((name.to_owned(), value.into()));
        self
    }
}

type Handler = dyn Fn(&Call, &str) -> Option<Reply> + Send + Sync;

pub struct FakeGitHub {
    pub url: String,
    calls: Arc<Mutex<Vec<Call>>>,
}

impl FakeGitHub {
    /// `handler` gets each request and the server's base URL (for Link headers).
    pub fn start(handler: impl Fn(&Call, &str) -> Option<Reply> + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let url = format!("http://{}", listener.local_addr().expect("addr"));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let handler: Arc<Handler> = Arc::new(handler);
        let (base, recorded) = (url.clone(), calls.clone());
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (handler, base, recorded) = (handler.clone(), base.clone(), recorded.clone());
                thread::spawn(move || serve(stream, &*handler, &base, &recorded));
            }
        });
        Self { url, calls }
    }

    pub fn client(&self) -> Client {
        Client::with_base_url(Token::new("github_pat_test").unwrap(), &self.url)
            .with_retry_wait(Duration::from_secs(2))
    }

    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("00");
                out.push(u8::from_str_radix(hex, 16).unwrap_or(b'?'));
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn read_call(reader: &mut BufReader<TcpStream>) -> Option<Call> {
    let mut line = String::new();
    if reader.read_line(&mut line).ok()? == 0 {
        return None;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_owned();
    let target = parts.next()?.to_owned();
    let mut headers = HashMap::new();
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).ok()?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }
    let length: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0; length];
    reader.read_exact(&mut body).ok()?;
    let (path, search) = target.split_once('?').unwrap_or((&target, ""));
    let query = search
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            (decode(k), decode(v))
        })
        .collect();
    Some(Call {
        method,
        path: decode(path),
        search: search.to_owned(),
        query,
        headers,
        body: serde_json::from_slice(&body).unwrap_or(Value::Null),
    })
}

fn serve(stream: TcpStream, handler: &Handler, base: &str, calls: &Mutex<Vec<Call>>) {
    let mut writer = stream.try_clone().expect("clone stream");
    let mut reader = BufReader::new(stream);
    while let Some(call) = read_call(&mut reader) {
        calls.lock().unwrap().push(call.clone());
        let reply = handler(&call, base).unwrap_or_else(|| {
            Reply::json(serde_json::json!({ "message": format!("Unexpected {} {}", call.method, call.path) }))
                .status(599)
        });
        let mut head = format!(
            "HTTP/1.1 {} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\n",
            reply.status,
            reply.body.len()
        );
        for (name, value) in &reply.headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        head.push_str("\r\n");
        if writer.write_all(head.as_bytes()).is_err()
            || writer.write_all(reply.body.as_bytes()).is_err()
        {
            return;
        }
    }
}
