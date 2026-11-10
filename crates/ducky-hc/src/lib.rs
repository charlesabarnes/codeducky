//! herdr-core (`hc`) client: one framed connection carrying calls, event subscriptions and
//! terminal attach streams, plus [`HcHost`], a `ducky_host::Host` for one machine.
//!
//! Everything blocks; call it from a background executor. Nothing reconnects by itself: once a
//! call returns [`Error::Disconnected`], make a new [`Client`].

mod api;
mod attach;
mod client;
mod error;
mod events;
mod host;
pub mod socket;
mod types;
pub mod wire;

pub use api::{MAX_EXEC_STDERR, MAX_EXEC_STDIN, MAX_EXEC_STDOUT, MAX_EXEC_TIMEOUT, MAX_FILE_IO};
pub use attach::{AttachOutput, Attachment, StreamEvent};
pub use client::{Client, GENERATION};
pub use error::{Error, Result, RpcError};
pub use events::{Event, EventKind, EventMessage, Subscription};
pub use host::HcHost;
pub use types::*;
