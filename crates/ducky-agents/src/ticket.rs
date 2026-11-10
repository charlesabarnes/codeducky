//! Knowing when an agent is done with a task we handed it.
//!
//! herdr-core raises a terminal's `turn` each time its reported status leaves `working`. A task
//! remembers the turn at the moment its text went in; once the turn has moved past that, the
//! agent's status word says how the turn ended. A program that never reports status keeps its
//! turn, so its task ends only when it exits.

use ducky_hc::Terminal;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskKind {
    Review,
    Fix,
    Custom,
}

impl TaskKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Review => "review",
            Self::Fix => "fix",
            Self::Custom => "custom",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskTicket {
    pub address: String,
    pub kind: TaskKind,
    /// The terminal's turn when the task went in.
    pub turn: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskProgress {
    /// The agent stopped to ask a person; the task goes on once they answer.
    Blocked,
    Finished(TurnEnd),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnEnd {
    Done,
    /// Stopped without saying it finished (interrupted, or an agent that only says idle).
    Idle,
    Error,
    Exited {
        code: Option<i32>,
    },
    Removed,
}

impl TaskTicket {
    /// What the terminal's record says about this task now; `None` while its turn goes on.
    /// Moves the ticket on to the current turn when the agent blocked or started another turn.
    pub fn progress(&mut self, terminal: Option<&Terminal>) -> Option<TaskProgress> {
        let Some(terminal) = terminal else {
            return Some(TaskProgress::Finished(TurnEnd::Removed));
        };
        if terminal.state == "finished" {
            return Some(TaskProgress::Finished(TurnEnd::Exited {
                code: terminal.exit_code,
            }));
        }
        if terminal.turn <= self.turn {
            return None;
        }
        let word = terminal.status.as_ref().map(|s| s.state.as_str());
        let end = match word {
            Some("blocked") => {
                self.turn = terminal.turn;
                return Some(TaskProgress::Blocked);
            }
            Some("working") => {
                self.turn = terminal.turn;
                return None;
            }
            Some("done") => TurnEnd::Done,
            Some("error") => TurnEnd::Error,
            _ => TurnEnd::Idle,
        };
        Some(TaskProgress::Finished(end))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::test_support::terminal;

    fn ticket() -> TaskTicket {
        TaskTicket {
            address: "t1".into(),
            kind: TaskKind::Fix,
            turn: 3,
        }
    }

    #[test]
    fn the_turn_must_move_past_the_send() {
        let mut t = ticket();
        let working = terminal(json!({"turn": 3, "status": {"state": "working"}}));
        assert_eq!(t.progress(Some(&working)), None);
        let done = terminal(json!({"turn": 4, "status": {"state": "done"}}));
        assert_eq!(
            t.progress(Some(&done)),
            Some(TaskProgress::Finished(TurnEnd::Done))
        );
        let idle = terminal(json!({"turn": 4, "status": {"state": "idle"}}));
        assert_eq!(
            ticket().progress(Some(&idle)),
            Some(TaskProgress::Finished(TurnEnd::Idle))
        );
    }

    #[test]
    fn blocking_reports_once_and_waits_for_the_next_turn() {
        let mut t = ticket();
        let blocked = terminal(json!({"turn": 4, "status": {"state": "blocked"}}));
        assert_eq!(t.progress(Some(&blocked)), Some(TaskProgress::Blocked));
        assert_eq!(t.turn, 4);
        assert_eq!(t.progress(Some(&blocked)), None);
        let errored = terminal(json!({"turn": 5, "status": {"state": "error"}}));
        assert_eq!(
            t.progress(Some(&errored)),
            Some(TaskProgress::Finished(TurnEnd::Error))
        );
    }

    #[test]
    fn exit_and_removal_end_it_whatever_the_turn() {
        let exited = terminal(json!({"turn": 0, "state": "finished", "exit_code": 1}));
        assert_eq!(
            ticket().progress(Some(&exited)),
            Some(TaskProgress::Finished(TurnEnd::Exited { code: Some(1) }))
        );
        assert_eq!(
            ticket().progress(None),
            Some(TaskProgress::Finished(TurnEnd::Removed))
        );
        let unreported = terminal(json!({"turn": 3}));
        assert_eq!(ticket().progress(Some(&unreported)), None);
    }
}
