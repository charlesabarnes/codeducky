//! What became of a task's text, in words the UI can show.

use ducky_hc::{Error, FirstMessage, SendResult};

use crate::ticket::{TaskKind, TaskTicket};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Delivery {
    /// It went in. `started`: the agent went `working` within a few seconds; `None` when it
    /// does not report status, so nobody can tell.
    Sent {
        ticket: TaskTicket,
        started: Option<bool>,
    },
    /// It went in while the agent was busy; the agent takes it up when it gets to it.
    Queued {
        ticket: TaskTicket,
    },
    /// It went in but the agent did not start working: it may be showing a dialog.
    NotStarted {
        ticket: TaskTicket,
    },
    /// The agent waits for a person (a permission or a question); nothing was typed.
    RefusedBlocked,
    Failed {
        reason: String,
    },
}

impl Delivery {
    /// For following the task with [`crate::AgentDirectory::track`].
    pub fn ticket(&self) -> Option<&TaskTicket> {
        match self {
            Self::Sent { ticket, .. } | Self::Queued { ticket } | Self::NotStarted { ticket } => {
                Some(ticket)
            }
            Self::RefusedBlocked | Self::Failed { .. } => None,
        }
    }

    pub fn from_send(address: &str, kind: TaskKind, result: Result<SendResult, Error>) -> Self {
        let result = match result {
            Ok(result) => result,
            Err(error) => return Self::from_error(&error),
        };
        let ticket = TaskTicket {
            address: address.to_owned(),
            kind,
            turn: result.turn,
        };
        match (result.status.as_deref(), result.started) {
            (Some("working"), _) => Self::Queued { ticket },
            (_, Some(false)) => Self::NotStarted { ticket },
            (_, started) => Self::Sent { ticket, started },
        }
    }

    /// A template launch's first message.
    pub fn from_first_message(address: &str, kind: TaskKind, first: &FirstMessage) -> Self {
        if !first.sent {
            let reason = first
                .reason
                .clone()
                .unwrap_or_else(|| "the agent never became ready".into());
            return Self::Failed { reason };
        }
        let ticket = TaskTicket {
            address: address.to_owned(),
            kind,
            turn: first.turn.unwrap_or(0),
        };
        match first.started {
            Some(false) => Self::NotStarted { ticket },
            started => Self::Sent { ticket, started },
        }
    }

    fn from_error(error: &Error) -> Self {
        let reason = match error.kind() {
            Some("blocked") => return Self::RefusedBlocked,
            Some("finished") => "the agent has exited".into(),
            Some("not_found") => "the terminal is gone".into(),
            _ => error.to_string(),
        };
        Self::Failed { reason }
    }
}

#[cfg(test)]
mod tests {
    use ducky_hc::RpcError;
    use serde_json::json;

    use super::*;

    fn sent(json: serde_json::Value) -> Delivery {
        let result: SendResult = serde_json::from_value(json).unwrap();
        Delivery::from_send("t1", TaskKind::Fix, Ok(result))
    }

    fn rpc(kind: &str) -> Error {
        RpcError::from_json(&json!({"code": -32000, "message": kind, "data": {"kind": kind}}))
            .into()
    }

    #[test]
    fn send_results_map_to_outcomes() {
        let ticket = TaskTicket {
            address: "t1".into(),
            kind: TaskKind::Fix,
            turn: 2,
        };
        assert_eq!(
            sent(json!({"turn": 2, "status": "idle", "started": true})),
            Delivery::Sent {
                ticket: ticket.clone(),
                started: Some(true)
            }
        );
        assert_eq!(
            sent(json!({"turn": 2, "status": "working", "started": true})),
            Delivery::Queued {
                ticket: ticket.clone()
            }
        );
        assert_eq!(
            sent(json!({"turn": 2, "status": "idle", "started": false})),
            Delivery::NotStarted { ticket }
        );
        assert!(matches!(
            sent(json!({"turn": 0, "status": null, "started": null})),
            Delivery::Sent { started: None, .. }
        ));
    }

    #[test]
    fn refusals_and_failures_carry_no_ticket() {
        let refused = Delivery::from_send("t1", TaskKind::Fix, Err(rpc("blocked")));
        assert_eq!(refused, Delivery::RefusedBlocked);
        assert!(refused.ticket().is_none());
        assert_eq!(
            Delivery::from_send("t1", TaskKind::Fix, Err(rpc("finished"))),
            Delivery::Failed {
                reason: "the agent has exited".into()
            }
        );
    }

    #[test]
    fn first_messages_report_whether_they_went_in() {
        let first = |json| serde_json::from_value::<FirstMessage>(json).unwrap();
        let failed = Delivery::from_first_message(
            "t1",
            TaskKind::Review,
            &first(json!({"sent": false, "reason": "it exited before it was ready"})),
        );
        assert_eq!(
            failed,
            Delivery::Failed {
                reason: "it exited before it was ready".into()
            }
        );
        let ok = Delivery::from_first_message(
            "t1",
            TaskKind::Review,
            &first(json!({"sent": true, "started": true, "turn": 0})),
        );
        assert_eq!(ok.ticket().unwrap().turn, 0);
    }
}
