//! herdr-core's machines: list them with their line, add, reconnect, rename and forget them.
//! Removing only forgets a machine here; its terminals keep running there.

mod error;
mod ssh_config;

use ducky_hc::{Client, Machine, MachineAdd};

pub use error::MachineError;
pub use ssh_config::{ssh_config_hosts, ssh_hosts};

use crate::connection::Connection;
use crate::error::{Result, SessionError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MachineState {
    Connected,
    Connecting,
    NeedsLogin,
    Unreachable,
    Other(String),
}

impl MachineState {
    fn parse(state: Option<&str>) -> Self {
        match state {
            Some("connected") => Self::Connected,
            Some("connecting") | None => Self::Connecting,
            Some("needs_login") => Self::NeedsLogin,
            Some("unreachable") => Self::Unreachable,
            Some(other) => Self::Other(other.to_owned()),
        }
    }

    pub fn label(&self) -> &str {
        match self {
            Self::Connected => "connected",
            Self::Connecting => "connecting",
            Self::NeedsLogin => "needs login",
            Self::Unreachable => "unreachable",
            Self::Other(word) => word,
        }
    }

    pub fn is_connected(&self) -> bool {
        *self == Self::Connected
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineEntry {
    pub name: String,
    /// An ssh target, or the command for a `via` machine.
    pub target: String,
    pub host: String,
    pub via: bool,
    pub temporary: bool,
    pub state: MachineState,
    /// Why it is not connected, in the core's words.
    pub why: Option<String>,
}

impl From<Machine> for MachineEntry {
    fn from(machine: Machine) -> Self {
        Self {
            state: MachineState::parse(machine.state.as_deref()),
            name: machine.name,
            target: machine.target,
            host: machine.host,
            via: machine.via,
            temporary: machine.temporary,
            why: machine.why.filter(|w| !w.is_empty()),
        }
    }
}

/// What the add-machine form gathers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NewMachine {
    /// `vps`, `me@10.0.0.7:2222`, or a Host from ~/.ssh/config. With `via`, ignored.
    pub target: String,
    pub name: Option<String>,
    /// A command that runs a shell line there, instead of ssh. Needs a name.
    pub via: Option<String>,
}

impl NewMachine {
    fn params(&self) -> std::result::Result<MachineAdd, MachineError> {
        let trim = |s: &str| Some(s.trim().to_owned()).filter(|s| !s.is_empty());
        let name = self.name.as_deref().and_then(trim);
        let via = self.via.as_deref().and_then(trim);
        let target = trim(&self.target);
        match (&target, &via, &name) {
            (_, Some(_), None) => Err(MachineError::input(
                "a machine reached by a command needs a name",
            )),
            (None, None, _) => Err(MachineError::input(
                "enter an ssh target or a Host from ~/.ssh/config",
            )),
            _ => Ok(MachineAdd {
                target: if via.is_some() { None } else { target },
                name,
                via,
                ..MachineAdd::default()
            }),
        }
    }
}

#[derive(Clone)]
pub struct MachinesService {
    client: Client,
}

impl MachinesService {
    pub fn new(connection: &Connection) -> Result<Self> {
        let client = connection.client().ok_or(SessionError::LocalOnly)?.clone();
        Ok(Self { client })
    }

    pub fn list(&self) -> std::result::Result<Vec<MachineEntry>, MachineError> {
        let machines = self.client.machine_list().map_err(MachineError::from_hc)?;
        Ok(machines.into_iter().map(MachineEntry::from).collect())
    }

    /// Blocks while the core dials it (ssh can take a while).
    pub fn add(&self, new: &NewMachine) -> std::result::Result<MachineEntry, MachineError> {
        let params = new.params()?;
        let added = self
            .client
            .machine_add(&params)
            .map_err(MachineError::from_hc)?;
        Ok(self.listed(&added.name).unwrap_or_else(|| added.into()))
    }

    pub fn reconnect(&self, name: &str) -> std::result::Result<MachineEntry, MachineError> {
        self.client
            .machine_connect(name)
            .map(MachineEntry::from)
            .map_err(MachineError::from_hc)
    }

    pub fn rename(
        &self,
        name: &str,
        new_name: &str,
    ) -> std::result::Result<MachineEntry, MachineError> {
        let new_name = new_name.trim();
        if new_name.is_empty() {
            return Err(MachineError::input("enter a new name"));
        }
        let renamed = self
            .client
            .machine_rename(name, new_name)
            .map_err(MachineError::from_hc)?;
        Ok(self.listed(&renamed.name).unwrap_or_else(|| renamed.into()))
    }

    /// Forgets the machine here; its terminals keep running there.
    pub fn remove(&self, name: &str) -> std::result::Result<(), MachineError> {
        self.client
            .machine_rm(name)
            .map(drop)
            .map_err(MachineError::from_hc)
    }

    /// The listed record, which carries the line state the add and rename replies lack.
    fn listed(&self, name: &str) -> Option<MachineEntry> {
        self.list().ok()?.into_iter().find(|m| m.name == name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_form_needs_a_target_or_a_named_command() {
        let ssh = NewMachine {
            target: " vps ".into(),
            name: Some(" ".into()),
            via: None,
        };
        let params = ssh.params().unwrap();
        assert_eq!(params.target.as_deref(), Some("vps"));
        assert_eq!(params.name, None);

        let via = NewMachine {
            target: "ignored".into(),
            name: Some("box".into()),
            via: Some("fly ssh console -C".into()),
        };
        let params = via.params().unwrap();
        assert_eq!(params.target, None);
        assert_eq!(params.via.as_deref(), Some("fly ssh console -C"));

        assert!(NewMachine::default().params().is_err());
        let unnamed = NewMachine {
            via: Some("x".into()),
            ..NewMachine::default()
        };
        assert!(unnamed.params().unwrap_err().to_string().contains("name"));
    }

    #[test]
    fn states_read_as_words() {
        assert_eq!(
            MachineState::parse(Some("needs_login")).label(),
            "needs login"
        );
        assert!(MachineState::parse(Some("connected")).is_connected());
        assert_eq!(MachineState::parse(None), MachineState::Connecting);
    }
}
