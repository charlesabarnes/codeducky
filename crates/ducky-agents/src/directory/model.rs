//! Every terminal the core reported, kept current from its events.
//!
//! All terminals are kept, not only the repo's, because one can move into the repo later
//! (its foreground folder changes). Event payloads as herdr-core 0.1.19 sends them: `created`
//! carries the whole record; the others only what changed.

use std::collections::BTreeMap;

use ducky_hc::{Event, EventKind, Foreground, Labels, Status, Terminal};
use serde::de::DeserializeOwned;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Applied {
    Changed,
    Removed,
    /// The status left `working`.
    TurnEnded,
    /// The event does not say enough (or names a terminal we have not seen): fetch it.
    Refetch,
    Ignored,
}

#[derive(Debug, Default)]
pub struct Model {
    terminals: BTreeMap<String, Terminal>,
}

fn field<T: DeserializeOwned>(data: &Value, key: &str) -> Option<T> {
    serde_json::from_value(data.get(key)?.clone()).ok()
}

impl Model {
    pub fn reset(&mut self, terminals: Vec<Terminal>) {
        self.terminals = terminals
            .into_iter()
            .map(|t| (t.address.clone(), t))
            .collect();
    }

    pub fn get(&self, address: &str) -> Option<&Terminal> {
        self.terminals.get(address)
    }

    pub fn set(&mut self, terminal: Terminal) {
        self.terminals.insert(terminal.address.clone(), terminal);
    }

    pub fn remove(&mut self, address: &str) {
        self.terminals.remove(address);
    }

    pub fn terminals(&self) -> impl Iterator<Item = &Terminal> {
        self.terminals.values()
    }

    pub fn apply(&mut self, event: &Event) -> Applied {
        let Some(address) = event.terminal.as_deref() else {
            return Applied::Ignored;
        };
        if let Some(record) = event.record() {
            self.set(record);
            return Applied::Changed;
        }
        match event.kind {
            EventKind::Created => match serde_json::from_value::<Terminal>(event.data.clone()) {
                Ok(record) => {
                    self.set(record);
                    Applied::Changed
                }
                Err(_) => Applied::Refetch,
            },
            EventKind::Removed => {
                self.remove(address);
                Applied::Removed
            }
            EventKind::Doc | EventKind::Keep => Applied::Ignored,
            EventKind::Lost | EventKind::Restarted | EventKind::Other(_) => Applied::Refetch,
            _ => match self.terminals.get_mut(address) {
                Some(terminal) => update(terminal, &event.kind, &event.data),
                None => Applied::Refetch,
            },
        }
    }
}

fn update(terminal: &mut Terminal, kind: &EventKind, data: &Value) -> Applied {
    match kind {
        EventKind::Status => {
            terminal.status = field::<Status>(data, "status");
            if let Some(reported) = data["reported"].as_bool() {
                terminal.reported = reported;
            }
        }
        EventKind::Turn => {
            let Some(turn) = data["turn"].as_u64() else {
                return Applied::Refetch;
            };
            terminal.turn = turn;
            return Applied::TurnEnded;
        }
        EventKind::Title => terminal.title = data["title"].as_str().unwrap_or_default().into(),
        EventKind::Labels => terminal.labels = field::<Labels>(data, "labels").unwrap_or_default(),
        EventKind::Size => {
            let size = |key: &str| data[key].as_u64().and_then(|n| u16::try_from(n).ok());
            if let (Some(cols), Some(rows)) = (size("cols"), size("rows")) {
                terminal.cols = cols;
                terminal.rows = rows;
            }
        }
        EventKind::Foreground => {
            terminal.foreground = serde_json::from_value::<Foreground>(data.clone()).ok();
        }
        EventKind::Finished => {
            terminal.state = "finished".into();
            terminal.exit_code = field(data, "exit_code");
            terminal.signal = field(data, "signal");
            terminal.reason = field(data, "reason");
            terminal.finished_ms = field(data, "finished_ms");
            terminal.foreground = None;
            terminal.status = None;
        }
        _ => return Applied::Ignored,
    }
    Applied::Changed
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::test_support::terminal;

    fn event(kind: &str, data: Value) -> Event {
        Event {
            seq: 1,
            kind: EventKind::from(kind),
            terminal: Some("t1".into()),
            machine: None,
            data,
        }
    }

    #[test]
    fn events_as_the_core_sends_them_update_the_record() {
        let mut model = Model::default();
        let created = serde_json::to_value(json!({
            "address": "t1", "argv": ["/tmp/fake.sh"], "cwd": "/tmp", "state": "live",
            "labels": {}, "created_ms": 5, "cols": 200, "rows": 120, "screen": "exact",
            "reported": false, "status": null, "turn": 0, "name": "fk",
        }))
        .unwrap();
        assert_eq!(model.apply(&event("created", created)), Applied::Changed);
        let status = json!({"records": {}, "reported": true,
            "status": {"app": "fake-agent", "state": "working"}});
        assert_eq!(model.apply(&event("status", status)), Applied::Changed);
        assert_eq!(
            model.apply(&event("turn", json!({"state": "done", "turn": 1}))),
            Applied::TurnEnded
        );
        model.apply(&event("labels", json!({"labels": {"where": "x / y"}})));
        model.apply(&event("size", json!({"cols": 90, "rows": 30})));
        model.apply(&event("title", json!({"title": "vim"})));
        model.apply(&event(
            "foreground",
            json!({"argv": ["sh"], "cwd": "/private/tmp", "name": "bash", "pid": 9}),
        ));
        let t = model.get("t1").unwrap();
        assert!(t.reported);
        assert_eq!(t.status.as_ref().unwrap().state, "working");
        assert_eq!(t.turn, 1);
        assert_eq!(t.labels["where"], "x / y");
        assert_eq!((t.cols, t.rows), (90, 30));
        assert_eq!(t.title, "vim");
        assert_eq!(t.foreground.as_ref().unwrap().cwd, "/private/tmp");

        let finished =
            json!({"exit_code": null, "finished_ms": 9, "reason": "killed", "signal": 1});
        model.apply(&event("finished", finished));
        let t = model.get("t1").unwrap();
        assert_eq!(t.state, "finished");
        assert_eq!(t.reason.as_deref(), Some("killed"));
        assert!(t.foreground.is_none());

        assert_eq!(model.apply(&event("removed", json!({}))), Applied::Removed);
        assert!(model.get("t1").is_none());
    }

    #[test]
    fn unknown_terminals_and_loss_are_fetched() {
        let mut model = Model::default();
        assert_eq!(
            model.apply(&event("status", json!({"status": null}))),
            Applied::Refetch
        );
        model.set(terminal(json!({})));
        assert_eq!(model.apply(&event("lost", json!({}))), Applied::Refetch);
        assert_eq!(
            model.apply(&event("restarted", json!({}))),
            Applied::Refetch
        );
    }

    #[test]
    fn a_record_in_the_event_replaces_ours() {
        let mut model = Model::default();
        model.set(terminal(json!({})));
        let record = serde_json::to_value(json!({
            "address": "t1", "argv": ["x"], "cwd": "/new", "state": "live", "labels": {},
            "created_ms": 1, "cols": 1, "rows": 1, "screen": "exact",
        }))
        .unwrap();
        model.apply(&event("labels", json!({"labels": {}, "record": record})));
        assert_eq!(model.get("t1").unwrap().cwd, "/new");
    }
}
