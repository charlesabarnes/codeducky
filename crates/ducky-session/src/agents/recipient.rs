//! Which agent a hand-off goes to.

use ducky_agents::{AgentInfo, AgentKind};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recipient {
    Agent(String),
    NewAgent,
}

/// Live terminals that can take a task: everything but a bare shell.
pub fn candidates(agents: &[AgentInfo]) -> Vec<&AgentInfo> {
    agents
        .iter()
        .filter(|a| a.is_live() && a.kind != AgentKind::Shell)
        .collect()
}

/// The most recently used candidate (`recent` is newest first), else the newest one, else a new
/// agent.
pub fn default_recipient(agents: &[AgentInfo], recent: &[String]) -> Recipient {
    let candidates = candidates(agents);
    recent
        .iter()
        .find(|address| candidates.iter().any(|a| &a.address == *address))
        .cloned()
        .or_else(|| {
            candidates
                .iter()
                .max_by_key(|a| a.created_ms)
                .map(|a| a.address.clone())
        })
        .map_or(Recipient::NewAgent, Recipient::Agent)
}

#[cfg(test)]
mod tests {
    use ducky_agents::AgentStatus;

    use super::*;

    fn agent(address: &str, kind: AgentKind, created_ms: u64, live: bool) -> AgentInfo {
        AgentInfo {
            address: address.into(),
            name: None,
            kind,
            program: String::new(),
            status: if live {
                AgentStatus::Idle
            } else {
                AgentStatus::Exited {
                    code: Some(0),
                    reason: None,
                }
            },
            status_message: None,
            turn: 0,
            title: String::new(),
            where_label: None,
            cwd: "/r".into(),
            launch_cwd: "/r".into(),
            template: None,
            started_by_ducky: false,
            created_ms,
            status_ms: None,
            cols: 80,
            rows: 24,
        }
    }

    #[test]
    fn prefers_the_last_used_then_the_newest_live_agent() {
        let agents = vec![
            agent("t1", AgentKind::ClaudeCode, 1, true),
            agent("t2", AgentKind::Codex, 2, true),
            agent("t3", AgentKind::Shell, 3, true),
            agent("t4", AgentKind::ClaudeCode, 4, false),
        ];
        assert_eq!(candidates(&agents).len(), 2);
        assert_eq!(
            default_recipient(&agents, &[]),
            Recipient::Agent("t2".into())
        );
        assert_eq!(
            default_recipient(&agents, &["t4".into(), "t1".into()]),
            Recipient::Agent("t1".into())
        );
        assert_eq!(default_recipient(&agents[2..], &[]), Recipient::NewAgent);
    }
}
