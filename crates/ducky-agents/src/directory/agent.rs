//! What the agents panel shows for one terminal, derived from its hc record.

use ducky_hc::Terminal;

use crate::labels;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentKind {
    ClaudeCode,
    Codex,
    Pi,
    Shell,
    Other(String),
}

const SHELLS: &[&str] = &[
    "sh", "bash", "zsh", "fish", "nu", "dash", "ksh", "tcsh", "csh",
];

impl AgentKind {
    /// From a reported app or a program name (`claude-code`, `/usr/bin/codex`, `-zsh`).
    pub fn from_name(name: &str) -> Self {
        let name = name.rsplit('/').next().unwrap_or(name);
        let name = name.strip_prefix('-').unwrap_or(name);
        match name {
            "claude" | "claude-code" => Self::ClaudeCode,
            "codex" => Self::Codex,
            "pi" => Self::Pi,
            shell if SHELLS.contains(&shell) => Self::Shell,
            other => Self::Other(other.to_owned()),
        }
    }

    pub fn label(&self) -> &str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "Codex",
            Self::Pi => "pi",
            Self::Shell => "shell",
            Self::Other(name) => name,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentStatus {
    Working,
    Idle,
    Done,
    /// Waiting for a person: `kind` is `permission`, `question` or `auth` when it said.
    Blocked {
        kind: Option<String>,
    },
    Error,
    /// A plain program, or an agent that does not report status (OSC 7501).
    Unreported,
    Exited {
        code: Option<i32>,
        reason: Option<String>,
    },
    /// A word this build does not know.
    Other(String),
}

impl AgentStatus {
    pub fn from_terminal(terminal: &Terminal) -> Self {
        if terminal.state == "finished" {
            return Self::Exited {
                code: terminal.exit_code,
                reason: terminal.reason.clone(),
            };
        }
        let Some(status) = &terminal.status else {
            return if terminal.reported {
                Self::Idle
            } else {
                Self::Unreported
            };
        };
        match status.state.as_str() {
            "working" => Self::Working,
            "idle" => Self::Idle,
            "done" => Self::Done,
            "blocked" => Self::Blocked {
                kind: status.kind.clone(),
            },
            "error" => Self::Error,
            other => Self::Other(other.to_owned()),
        }
    }

    pub fn needs_attention(&self) -> bool {
        matches!(self, Self::Blocked { .. } | Self::Error)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentInfo {
    /// `t7` here, `machine/t7` elsewhere: what attach and send take.
    pub address: String,
    pub name: Option<String>,
    pub kind: AgentKind,
    /// The reported app, else the program's name, as `hc ls` shows it.
    pub program: String,
    pub status: AgentStatus,
    /// The agent's own words with its status, when it gave any.
    pub status_message: Option<String>,
    pub turn: u64,
    pub title: String,
    /// The `where` label: where a viewer put it, in words ("herdr-core / review").
    pub where_label: Option<String>,
    /// Where it works now (the foreground program's folder), else where it started.
    pub cwd: String,
    pub launch_cwd: String,
    pub template: Option<String>,
    pub started_by_ducky: bool,
    pub created_ms: u64,
    pub status_ms: Option<u64>,
    pub cols: u16,
    pub rows: u16,
}

impl AgentInfo {
    pub fn from_terminal(terminal: &Terminal) -> Self {
        let reported_app = terminal
            .status
            .as_ref()
            .and_then(|s| s.app.clone())
            .filter(|app| !app.is_empty());
        let launched = terminal
            .argv
            .first()
            .map(|p| p.rsplit('/').next().unwrap_or(p).to_owned())
            .unwrap_or_default();
        let program = reported_app.clone().unwrap_or_else(|| launched.clone());
        let kind = match (&reported_app, &terminal.foreground) {
            (Some(app), _) => AgentKind::from_name(app),
            (None, Some(fg)) => match fg.argv.first().map(|p| AgentKind::from_name(p)) {
                Some(kind) if kind != AgentKind::Shell => kind,
                _ => AgentKind::from_name(&launched),
            },
            (None, None) => AgentKind::from_name(&launched),
        };
        Self {
            address: terminal.address.clone(),
            name: terminal.name.clone(),
            kind,
            program,
            status: AgentStatus::from_terminal(terminal),
            status_message: terminal
                .status
                .as_ref()
                .and_then(|s| s.msg.clone())
                .filter(|m| !m.is_empty()),
            turn: terminal.turn,
            title: terminal.title.clone(),
            where_label: terminal
                .labels
                .get(labels::WHERE)
                .filter(|w| !w.is_empty())
                .cloned(),
            cwd: terminal
                .foreground
                .as_ref()
                .map_or_else(|| terminal.cwd.clone(), |fg| fg.cwd.clone()),
            launch_cwd: terminal.cwd.clone(),
            template: terminal.template.clone(),
            started_by_ducky: labels::started_by_ducky(&terminal.labels),
            created_ms: terminal.created_ms,
            status_ms: terminal.status_ms,
            cols: terminal.cols,
            rows: terminal.rows,
        }
    }

    pub fn is_live(&self) -> bool {
        !matches!(self.status, AgentStatus::Exited { .. })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::test_support::terminal;

    #[test]
    fn kind_comes_from_the_reported_app_then_the_foreground_then_argv() {
        let reported = terminal(json!({"status": {"state": "idle", "app": "claude-code"}}));
        assert_eq!(
            AgentInfo::from_terminal(&reported).kind,
            AgentKind::ClaudeCode
        );
        let in_shell = terminal(json!({"foreground": {
            "pid": 2, "name": "codex", "argv": ["/opt/bin/codex"], "cwd": "/repo/sub"}}));
        let info = AgentInfo::from_terminal(&in_shell);
        assert_eq!(info.kind, AgentKind::Codex);
        assert_eq!(info.cwd, "/repo/sub");
        assert_eq!(info.launch_cwd, "/repo");
        assert_eq!(info.program, "zsh");
        let shell = terminal(json!({"foreground": {
            "pid": 2, "name": "zsh", "argv": ["-zsh"], "cwd": "/repo"}}));
        assert_eq!(AgentInfo::from_terminal(&shell).kind, AgentKind::Shell);
        assert_eq!(
            AgentKind::from_name("python3"),
            AgentKind::Other("python3".into())
        );
    }

    #[test]
    fn status_words_and_their_absence() {
        let status = |extra| AgentStatus::from_terminal(&terminal(extra));
        assert_eq!(status(json!({})), AgentStatus::Unreported);
        assert_eq!(status(json!({"reported": true})), AgentStatus::Idle);
        assert_eq!(
            status(json!({"status": {"state": "blocked", "kind": "permission"}})),
            AgentStatus::Blocked {
                kind: Some("permission".into())
            }
        );
        assert_eq!(
            status(json!({"status": {"state": "working"}})),
            AgentStatus::Working
        );
        assert_eq!(
            status(json!({"state": "finished", "exit_code": 2, "reason": "exited"})),
            AgentStatus::Exited {
                code: Some(2),
                reason: Some("exited".into())
            }
        );
    }

    #[test]
    fn labels_give_where_and_ownership() {
        let info = AgentInfo::from_terminal(&terminal(json!({
            "labels": {"where": "ducky / review", "codeducky": "agent"},
            "status": {"state": "done", "msg": "all fixed"},
        })));
        assert_eq!(info.where_label.as_deref(), Some("ducky / review"));
        assert!(info.started_by_ducky);
        assert_eq!(info.status_message.as_deref(), Some("all fixed"));
    }
}
