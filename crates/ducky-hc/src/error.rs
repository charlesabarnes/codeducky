use serde_json::Value;

/// An error reply from the core. `kind` is stable across versions; match on it, not on `message`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{kind}: {message}")]
pub struct RpcError {
    pub code: i64,
    pub kind: String,
    pub message: String,
    pub hint: String,
}

impl RpcError {
    pub fn from_json(value: &Value) -> Self {
        Self {
            code: value["code"].as_i64().unwrap_or(-32603),
            kind: value["data"]["kind"]
                .as_str()
                .unwrap_or("internal")
                .to_owned(),
            message: value["message"].as_str().unwrap_or_default().to_owned(),
            hint: value["data"]["hint"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        }
    }

    pub fn is(&self, kind: &str) -> bool {
        self.kind == kind
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("no herdr-core socket at {0}; start herdr-core (`hc server status`)")]
    NotRunning(String),
    #[error("herdr-core connection: {0}")]
    Io(#[from] std::io::Error),
    /// The connection is gone. Make a new `Client`; nothing reconnects by itself.
    #[error("herdr-core connection closed")]
    Disconnected,
    #[error(transparent)]
    Rpc(#[from] RpcError),
    #[error("herdr-core protocol: {0}")]
    Protocol(String),
    #[error("no reply from herdr-core within the timeout")]
    Timeout,
}

impl Error {
    /// The stable `data.kind` of an RPC error.
    pub fn kind(&self) -> Option<&str> {
        match self {
            Self::Rpc(error) => Some(&error.kind),
            _ => None,
        }
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
