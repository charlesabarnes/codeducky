//! Request and reply shapes, after `hc schema` (herdr-core 0.1.19). Fields the app has no use
//! for are left out; unknown fields are ignored so newer cores still decode.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub type Labels = BTreeMap<String, String>;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct CoreInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HelloResult {
    pub generation: u32,
    pub version: String,
    pub core: CoreInfo,
    pub framed: bool,
    #[serde(default)]
    pub methods: Vec<String>,
    #[serde(default)]
    pub features: Vec<String>,
}

impl HelloResult {
    pub fn has_feature(&self, feature: &str) -> bool {
        self.features.iter().any(|f| f == feature)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct StatusResult {
    pub core: CoreInfo,
    pub version: String,
    pub pid: u32,
    pub uptime_ms: u64,
    pub live: u64,
    pub finished: u64,
    #[serde(default)]
    pub installed_by: Option<String>,
}

/// `machine.add` / `machine.rename` return the stored record; `machine.list` / `machine.connect`
/// add the connection fields (`state`, `since_ms`, `why`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Machine {
    pub name: String,
    pub target: String,
    pub id: String,
    pub host: String,
    pub version: String,
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub temporary: bool,
    #[serde(default)]
    pub via: bool,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub since_ms: Option<u64>,
    #[serde(default)]
    pub why: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct MachineAdd {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
    pub temporary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Status {
    pub state: String,
    #[serde(default)]
    pub app: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub msg: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub progress: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Foreground {
    pub pid: i32,
    pub name: String,
    pub argv: Vec<String>,
    pub cwd: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Terminal {
    /// `t7` here, `machine/t7` on another machine: what every terminal method takes.
    pub address: String,
    #[serde(default)]
    pub name: Option<String>,
    pub argv: Vec<String>,
    pub cwd: String,
    /// `running`, `finished`, `lost`, ...
    pub state: String,
    #[serde(default)]
    pub labels: Labels,
    pub created_ms: u64,
    #[serde(default)]
    pub finished_ms: Option<u64>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub signal: Option<i32>,
    pub cols: u16,
    pub rows: u16,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub status: Option<Status>,
    #[serde(default)]
    pub turn: u64,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub template: Option<String>,
    #[serde(default)]
    pub foreground: Option<Foreground>,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub keep: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TerminalList {
    pub terminals: Vec<Terminal>,
    #[serde(default)]
    pub hidden_finished: u64,
    #[serde(default)]
    pub machines: Vec<Machine>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Display {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// Cell size in pixels, `[width, height]`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell: Option<[u32; 2]>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Size {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct RunParams {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub argv: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub labels: Labels,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<Display>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<Size>,
    pub keep: bool,
    pub rm: bool,
    pub no_parent: bool,
    pub no_notify: bool,
    pub outlive_parent: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SendParams {
    pub terminal: String,
    /// Pasted, then submitted with Enter.
    pub text: String,
    pub force: bool,
    /// Only type if the status is exactly this: `idle` or `working`.
    #[serde(rename = "if", skip_serializing_if = "Option::is_none")]
    pub only_if: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SendResult {
    pub turn: u64,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub started: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KeysResult {
    pub turn: u64,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InterruptResult {
    /// `stopped`, `exited`, `still_working` or `unknown`.
    pub outcome: String,
    pub key: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReadResult {
    pub text: String,
    pub complete: bool,
    pub how: String,
    #[serde(default)]
    pub why: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RemoveResult {
    pub removed: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TemplateInfo {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub command: String,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ExecParams {
    pub argv: Vec<String>,
    /// A shell line (`sh -c`) instead of `argv`.
    pub line: Option<String>,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
    pub on: Option<String>,
    /// At most [`crate::MAX_EXEC_STDIN`] bytes.
    pub input: Option<Vec<u8>>,
    /// Seconds; the core's default is 60 and its maximum 600.
    pub timeout: Option<f64>,
}

/// Decoded from base64. `truncated` covers stdout (first 8 MB kept) and stderr (first 1 MB) alike.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecResult {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub truncated: bool,
    pub timed_out: bool,
    pub ms: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct FileRead {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
    /// First line to give, from 1.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FileReadResult {
    pub text: String,
    pub first: u64,
    pub last: u64,
    /// Lines in the whole file.
    pub lines: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FileResult {
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SubscribeParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children_of: Option<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub labels: Labels,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Snapshot {
    pub seq: u64,
    pub terminals: Vec<Terminal>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AttachParams {
    pub terminal: String,
    pub cols: u16,
    pub rows: u16,
    /// Scrollback lines replayed first (main screen only).
    pub history: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<Display>,
    /// Watch only: never type or resize.
    pub observe: bool,
    pub resize_notifications: bool,
    /// Back after a dropped line: sets the size only once active again.
    pub resumed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller: Option<String>,
}

impl AttachParams {
    pub fn new(terminal: impl Into<String>, cols: u16, rows: u16) -> Self {
        Self {
            terminal: terminal.into(),
            cols,
            rows,
            history: 0,
            display: None,
            observe: false,
            resize_notifications: false,
            resumed: false,
            caller: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct AttachResult {
    pub channel: u32,
    pub terminal: Terminal,
    pub resize_notifications: bool,
    /// False on a core that takes emulator replies only as plain DATA.
    pub automatic_input: bool,
}
