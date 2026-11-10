//! An agent's status as the panel shows it: a colour class and a word.

use ducky_agents::AgentStatus;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusTone {
    Working,
    Idle,
    Done,
    Blocked,
    Error,
    Unreported,
    Exited,
}

pub fn tone(status: &AgentStatus) -> StatusTone {
    match status {
        AgentStatus::Working => StatusTone::Working,
        AgentStatus::Idle => StatusTone::Idle,
        AgentStatus::Done => StatusTone::Done,
        AgentStatus::Blocked { .. } => StatusTone::Blocked,
        AgentStatus::Error => StatusTone::Error,
        AgentStatus::Unreported | AgentStatus::Other(_) => StatusTone::Unreported,
        AgentStatus::Exited { .. } => StatusTone::Exited,
    }
}

pub fn status_text(status: &AgentStatus) -> String {
    match status {
        AgentStatus::Working => "working".into(),
        AgentStatus::Idle => "idle".into(),
        AgentStatus::Done => "done".into(),
        AgentStatus::Blocked { kind: Some(kind) } => format!("needs you ({kind})"),
        AgentStatus::Blocked { kind: None } => "needs you".into(),
        AgentStatus::Error => "error".into(),
        AgentStatus::Unreported => "no status".into(),
        AgentStatus::Other(word) => word.clone(),
        AgentStatus::Exited {
            code: Some(code), ..
        } => format!("exited {code}"),
        AgentStatus::Exited {
            reason: Some(reason),
            ..
        } => reason.clone(),
        AgentStatus::Exited { .. } => "exited".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_for_each_status() {
        let blocked = AgentStatus::Blocked {
            kind: Some("permission".into()),
        };
        assert_eq!(tone(&blocked), StatusTone::Blocked);
        assert_eq!(status_text(&blocked), "needs you (permission)");
        let exited = AgentStatus::Exited {
            code: None,
            reason: Some("killed".into()),
        };
        assert_eq!(status_text(&exited), "killed");
        assert_eq!(
            tone(&AgentStatus::Other("x".into())),
            StatusTone::Unreported
        );
    }
}
