//! One typed method per core call the app uses.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::attach::{self, AttachOutput, Attachment};
use crate::client::Client;
use crate::error::{Error, Result};
use crate::events::Subscription;
use crate::types::*;

/// What `machine.exec` keeps of stdout; the rest is cut and `truncated` set.
pub const MAX_EXEC_STDOUT: usize = 8 << 20;
pub const MAX_EXEC_STDERR: usize = 1 << 20;
pub const MAX_EXEC_STDIN: usize = 8 << 20;
/// Seconds; longer exec timeouts are refused by the core.
pub const MAX_EXEC_TIMEOUT: f64 = 600.0;
/// Raw bytes per `file.write` (and the JSON size of one `file.read`).
pub const MAX_FILE_IO: usize = 8 << 20;

fn object(pairs: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Object(
        pairs
            .into_iter()
            .filter(|(_, v)| !v.is_null())
            .map(|(k, v)| (k.to_owned(), v))
            .collect::<Map<_, _>>(),
    )
}

#[derive(Deserialize)]
struct MachinesReply {
    machines: Vec<Machine>,
}

#[derive(Deserialize)]
struct TemplatesReply {
    templates: Vec<TemplateInfo>,
}

#[derive(Deserialize)]
struct RawExec {
    code: Option<i32>,
    signal: Option<i32>,
    stdout: String,
    stderr: String,
    truncated: bool,
    timed_out: bool,
    #[serde(default)]
    ms: u64,
}

pub(crate) fn decode_base64(field: &str, text: &str) -> Result<Vec<u8>> {
    BASE64
        .decode(text)
        .map_err(|error| Error::Protocol(format!("{field} is not base64: {error}")))
}

impl Client {
    pub fn server_status(&self) -> Result<StatusResult> {
        self.call("server.status", json!({}))
    }

    pub fn machine_list(&self) -> Result<Vec<Machine>> {
        Ok(self
            .call::<_, MachinesReply>("machine.list", json!({}))?
            .machines)
    }

    pub fn machine_add(&self, params: &MachineAdd) -> Result<Machine> {
        self.call("machine.add", params)
    }

    pub fn machine_connect(&self, machine: &str) -> Result<Machine> {
        self.call("machine.connect", json!({"machine": machine}))
    }

    pub fn machine_rename(&self, machine: &str, new_name: &str) -> Result<Machine> {
        self.call(
            "machine.rename",
            json!({"machine": machine, "new_name": new_name}),
        )
    }

    pub fn machine_rm(&self, machine: &str) -> Result<RemoveResult> {
        self.call("machine.rm", json!({"machine": machine}))
    }

    /// A nonzero exit, a signal or a timeout is a result, not an error.
    pub fn exec(&self, params: &ExecParams) -> Result<ExecResult> {
        self.exec_within(params, None)
    }

    /// `exec`, giving up on the reply after `deadline` (the core then cancels the program).
    pub fn exec_within(
        &self,
        params: &ExecParams,
        deadline: Option<std::time::Duration>,
    ) -> Result<ExecResult> {
        if params
            .input
            .as_ref()
            .is_some_and(|i| i.len() > MAX_EXEC_STDIN)
        {
            return Err(Error::Protocol(format!(
                "exec input is over {} MB",
                MAX_EXEC_STDIN >> 20
            )));
        }
        let request = object([
            (
                "argv",
                if params.line.is_some() {
                    Value::Null
                } else {
                    json!(params.argv)
                },
            ),
            ("line", json!(params.line)),
            ("cwd", json!(params.cwd)),
            ("env", json!(params.env)),
            ("on", json!(params.on)),
            (
                "input",
                json!(params.input.as_ref().map(|i| BASE64.encode(i))),
            ),
            ("timeout", json!(params.timeout)),
        ]);
        let raw: RawExec = match deadline {
            Some(deadline) => self.call_timeout("machine.exec", request, deadline)?,
            None => self.call("machine.exec", request)?,
        };
        Ok(ExecResult {
            code: raw.code,
            signal: raw.signal,
            stdout: decode_base64("stdout", &raw.stdout)?,
            stderr: decode_base64("stderr", &raw.stderr)?,
            truncated: raw.truncated,
            timed_out: raw.timed_out,
            ms: raw.ms,
        })
    }

    /// UTF-8 text only (`not_text` otherwise), whole lines, at most 8 MB as JSON per call.
    pub fn file_read(&self, params: &FileRead) -> Result<FileReadResult> {
        self.call("file.read", params)
    }

    /// Atomic replace, creating parent folders; at most [`MAX_FILE_IO`] bytes.
    pub fn file_write(&self, path: &str, on: Option<&str>, data: &[u8]) -> Result<FileResult> {
        if data.len() > MAX_FILE_IO {
            return Err(Error::Protocol(format!(
                "file.write takes at most {} MB",
                MAX_FILE_IO >> 20
            )));
        }
        self.call(
            "file.write",
            object([
                ("path", json!(path)),
                ("on", json!(on)),
                ("data", json!(BASE64.encode(data))),
            ]),
        )
    }

    pub fn terminal_list(&self, all: bool, labels: &Labels) -> Result<TerminalList> {
        self.call("terminal.list", json!({"all": all, "labels": labels}))
    }

    pub fn terminal_get(&self, terminal: &str) -> Result<Terminal> {
        self.call("terminal.get", json!({"terminal": terminal}))
    }

    pub fn terminal_run(&self, params: &RunParams) -> Result<Terminal> {
        self.call("terminal.run", params)
    }

    pub fn terminal_send(&self, params: &SendParams) -> Result<SendResult> {
        self.call("terminal.send", params)
    }

    /// Key names: `enter`, `esc`, `ctrl+c`, `alt+x`, `f5`, `a`, ...
    pub fn terminal_keys(&self, terminal: &str, keys: &[&str]) -> Result<KeysResult> {
        self.call("terminal.keys", json!({"terminal": terminal, "keys": keys}))
    }

    /// `timeout`: seconds to watch for an effect (the core's default is 10).
    pub fn terminal_interrupt(
        &self,
        terminal: &str,
        timeout: Option<f64>,
    ) -> Result<InterruptResult> {
        self.call(
            "terminal.interrupt",
            object([("terminal", json!(terminal)), ("timeout", json!(timeout))]),
        )
    }

    /// The screen plus `lines` of history above it, as text.
    pub fn terminal_read(&self, terminal: &str, lines: u64) -> Result<ReadResult> {
        self.call(
            "terminal.read",
            json!({"terminal": terminal, "lines": lines}),
        )
    }

    pub fn terminal_kill(&self, terminal: &str) -> Result<Terminal> {
        self.call("terminal.kill", json!({"terminal": terminal}))
    }

    /// Only a finished terminal; a live one is the `live` error.
    pub fn terminal_rm(&self, terminal: &str) -> Result<RemoveResult> {
        self.call("terminal.rm", json!({"terminal": terminal}))
    }

    pub fn templates_list(&self) -> Result<Vec<TemplateInfo>> {
        Ok(self
            .call::<_, TemplatesReply>("templates.list", json!({}))?
            .templates)
    }

    pub fn subscribe(&self, params: &SubscribeParams) -> Result<Subscription> {
        let (snapshot, stream) = self.open::<_, Snapshot>("events.subscribe", params)?;
        Ok(Subscription::new(snapshot, stream))
    }

    pub fn attach(&self, params: &AttachParams) -> Result<(Attachment, AttachOutput)> {
        let (info, stream) = self.open::<_, AttachResult>("terminal.attach", params)?;
        Ok(attach::split(info, stream))
    }
}
