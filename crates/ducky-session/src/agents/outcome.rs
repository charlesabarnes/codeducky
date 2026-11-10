//! What became of a hand-off, in the words a toast shows.

use ducky_agents::{Delivery, TaskKind, TaskProgress, TurnEnd};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutcomeLevel {
    Success,
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryOutcome {
    pub text: String,
    pub level: OutcomeLevel,
    /// The agent is blocked and nothing was typed; sending anyway may answer its dialog.
    pub offer_force: bool,
}

fn outcome(level: OutcomeLevel, text: String) -> DeliveryOutcome {
    DeliveryOutcome {
        text,
        level,
        offer_force: false,
    }
}

/// `agent` is how the person knows it: its name, else its address.
pub fn describe_delivery(delivery: &Delivery, agent: &str) -> DeliveryOutcome {
    match delivery {
        Delivery::Sent {
            ticket,
            started: Some(true),
        } => outcome(
            OutcomeLevel::Success,
            format!(
                "{} task sent to {agent}; it is working",
                ticket.kind.as_str()
            ),
        ),
        Delivery::Sent { ticket, .. } => outcome(
            OutcomeLevel::Info,
            format!(
                "{} task sent to {agent}. It does not report its status, so notes reload when \
                 the window regains focus (or press the reload key)",
                ticket.kind.as_str()
            ),
        ),
        Delivery::Queued { ticket } => outcome(
            OutcomeLevel::Info,
            format!(
                "{agent} is busy; the {} task is queued for after its current turn",
                ticket.kind.as_str()
            ),
        ),
        Delivery::NotStarted { .. } => outcome(
            OutcomeLevel::Warning,
            format!(
                "Sent to {agent}, but it did not start working: it may be showing a dialog. \
                 Look at its screen"
            ),
        ),
        Delivery::RefusedBlocked => DeliveryOutcome {
            text: format!(
                "{agent} is waiting for you (a permission or a question), so nothing was sent. \
                 Answer it, or send anyway: the text may answer its dialog"
            ),
            level: OutcomeLevel::Warning,
            offer_force: true,
        },
        Delivery::Failed { reason } => outcome(
            OutcomeLevel::Error,
            format!("Could not send to {agent}: {reason}"),
        ),
    }
}

/// A task's state for its agent's tab.
pub fn describe_progress(kind: TaskKind, progress: Option<&TaskProgress>) -> String {
    let kind = kind.as_str();
    match progress {
        None => format!("{kind}…"),
        Some(TaskProgress::Blocked) => format!("{kind}: needs you"),
        Some(TaskProgress::Finished(end)) => match end {
            TurnEnd::Done => format!("{kind}: done"),
            TurnEnd::Idle => format!("{kind}: stopped"),
            TurnEnd::Error => format!("{kind}: error"),
            TurnEnd::Exited { code: Some(code) } => format!("{kind}: exited {code}"),
            TurnEnd::Exited { code: None } => format!("{kind}: exited"),
            TurnEnd::Removed => format!("{kind}: terminal removed"),
        },
    }
}

#[cfg(test)]
mod tests {
    use ducky_agents::TaskTicket;

    use super::*;

    fn ticket() -> TaskTicket {
        TaskTicket {
            address: "t1".into(),
            kind: TaskKind::Fix,
            turn: 0,
        }
    }

    #[test]
    fn every_delivery_reads_as_words() {
        let sent = describe_delivery(
            &Delivery::Sent {
                ticket: ticket(),
                started: Some(true),
            },
            "fixer",
        );
        assert_eq!(sent.level, OutcomeLevel::Success);
        assert!(sent.text.contains("fix task sent to fixer"));

        let blocked = describe_delivery(&Delivery::RefusedBlocked, "fixer");
        assert!(blocked.offer_force);
        assert_eq!(blocked.level, OutcomeLevel::Warning);

        let failed = describe_delivery(
            &Delivery::Failed {
                reason: "the agent has exited".into(),
            },
            "fixer",
        );
        assert_eq!(failed.level, OutcomeLevel::Error);
        assert!(failed.text.ends_with("the agent has exited"));
        assert!(!failed.offer_force);

        let quiet = describe_delivery(
            &Delivery::Sent {
                ticket: ticket(),
                started: None,
            },
            "codex",
        );
        assert_eq!(quiet.level, OutcomeLevel::Info);
        assert!(
            describe_delivery(&Delivery::Queued { ticket: ticket() }, "x")
                .text
                .contains("queued")
        );
        assert!(
            describe_delivery(&Delivery::NotStarted { ticket: ticket() }, "x")
                .text
                .contains("dialog")
        );
    }

    #[test]
    fn progress_reads_short() {
        assert_eq!(describe_progress(TaskKind::Fix, None), "fix…");
        assert_eq!(
            describe_progress(
                TaskKind::Review,
                Some(&TaskProgress::Finished(TurnEnd::Done))
            ),
            "review: done"
        );
        assert_eq!(
            describe_progress(TaskKind::Fix, Some(&TaskProgress::Blocked)),
            "fix: needs you"
        );
    }
}
