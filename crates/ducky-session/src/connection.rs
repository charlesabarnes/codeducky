use std::path::PathBuf;
use std::sync::Arc;

use ducky_hc::{Client, HcHost, Machine};
use ducky_host::{Host, LocalHost};

use crate::error::{Result, SessionError};

/// What the app can reach: herdr-core and its machines, or this machine alone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionState {
    Core {
        name: String,
        version: String,
    },
    /// herdr-core did not answer; `reason` says why, for the status bar.
    LocalOnly {
        reason: String,
    },
}

impl ConnectionState {
    pub fn label(&self) -> String {
        match self {
            Self::Core { name, .. } => format!("herdr-core: {name}"),
            Self::LocalOnly { .. } => "herdr-core not running — local only".into(),
        }
    }

    pub fn is_local_only(&self) -> bool {
        matches!(self, Self::LocalOnly { .. })
    }
}

/// Which core to talk to. A [`CoreTarget::Socket`] never falls back to the default socket, so a
/// dev run pointed at a scratch core cannot reach the live one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum CoreTarget {
    #[default]
    Default,
    Socket(PathBuf),
}

#[derive(Clone)]
pub struct Connection {
    client: Option<Client>,
    state: ConnectionState,
    target: CoreTarget,
}

impl std::fmt::Debug for Connection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Connection")
            .field("state", &self.state)
            .finish()
    }
}

impl Connection {
    /// The running herdr-core, else this machine through [`LocalHost`]. Never starts a core.
    pub fn connect() -> Self {
        Self::connect_to(CoreTarget::Default)
    }

    pub fn connect_to(target: CoreTarget) -> Self {
        let client = match &target {
            CoreTarget::Default => Client::connect_default(),
            CoreTarget::Socket(path) => Client::connect(path),
        };
        let connection = match client {
            Ok(client) => Self::core(client),
            Err(error) => Self::local_only(error.to_string()),
        };
        Self {
            target,
            ..connection
        }
    }

    /// The same target again, for a retry or after the core restarted.
    pub fn reconnect(&self) -> Self {
        Self::connect_to(self.target.clone())
    }

    pub fn core(client: Client) -> Self {
        let hello = client.hello();
        let state = ConnectionState::Core {
            name: hello.core.name.clone(),
            version: hello.version.clone(),
        };
        Self {
            client: Some(client),
            state,
            target: CoreTarget::Default,
        }
    }

    pub fn local_only(reason: impl Into<String>) -> Self {
        Self {
            client: None,
            state: ConnectionState::LocalOnly {
                reason: reason.into(),
            },
            target: CoreTarget::Default,
        }
    }

    pub fn target(&self) -> &CoreTarget {
        &self.target
    }

    /// The core's client; `None` when running local only.
    pub fn client(&self) -> Option<&Client> {
        self.client.as_ref()
    }

    pub fn is_alive(&self) -> bool {
        self.client.as_ref().is_some_and(Client::is_connected)
    }

    pub fn state(&self) -> &ConnectionState {
        &self.state
    }

    /// `machine: None` is the machine the app runs on.
    pub fn host(&self, machine: Option<&str>) -> Result<Arc<dyn Host>> {
        match (&self.client, machine) {
            (Some(client), machine) => Ok(Arc::new(HcHost::new(
                client.clone(),
                machine.map(str::to_owned),
            ))),
            (None, None) => Ok(Arc::new(LocalHost)),
            (None, Some(_)) => Err(SessionError::LocalOnly),
        }
    }

    /// herdr-core's machines; empty when running local only.
    pub fn machines(&self) -> Result<Vec<Machine>> {
        match &self.client {
            Some(client) => client.machine_list().map_err(|error| {
                SessionError::Host(ducky_host::HostError::Other(error.to_string()))
            }),
            None => Ok(Vec::new()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_only_reaches_this_machine_and_refuses_others() {
        let connection = Connection::local_only("no socket");
        assert!(connection.state().is_local_only());
        assert_eq!(connection.host(None).unwrap().name(), "local");
        assert!(matches!(
            connection.host(Some("tower")),
            Err(SessionError::LocalOnly)
        ));
        assert!(connection.machines().unwrap().is_empty());
        assert!(connection.client().is_none());
    }

    #[test]
    fn a_socket_target_never_falls_back_to_the_default_core() {
        let missing = std::env::temp_dir().join("codeducky-no-such-core.sock");
        let connection = Connection::connect_to(CoreTarget::Socket(missing.clone()));
        assert!(connection.state().is_local_only());
        assert_eq!(connection.target(), &CoreTarget::Socket(missing));
        assert!(connection.reconnect().state().is_local_only());
    }
}
