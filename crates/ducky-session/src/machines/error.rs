//! A machine call's failure, in words: what went wrong by hc's stable error kind, the core's
//! own message, and its hint.

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{text}")]
pub struct MachineError {
    /// hc's `data.kind`, when the core answered with one.
    pub kind: Option<String>,
    pub text: String,
}

fn headline(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "unreachable" => "Cannot reach the machine",
        "hc_missing" => "herdr-core is not installed there (or is too old)",
        "incompatible" => "Its herdr-core does not work with this one",
        "name_taken" => "That name is taken",
        "already_added" => "That machine is already added",
        "machine_unknown" => "herdr-core does not know that machine (refresh the list)",
        "invalid_params" => "Not a valid machine",
        _ => return None,
    })
}

impl MachineError {
    pub fn input(text: impl Into<String>) -> Self {
        Self {
            kind: None,
            text: text.into(),
        }
    }

    pub fn from_hc(error: ducky_hc::Error) -> Self {
        let ducky_hc::Error::Rpc(rpc) = &error else {
            return Self::input(error.to_string());
        };
        let mut text = match headline(&rpc.kind) {
            Some(headline) if rpc.message.is_empty() || rpc.message == rpc.kind => {
                headline.to_owned()
            }
            Some(headline) => format!("{headline}: {}", rpc.message),
            None if rpc.message.is_empty() => rpc.kind.clone(),
            None => rpc.message.clone(),
        };
        if !rpc.hint.is_empty() {
            text.push_str(&format!(". {}", rpc.hint));
        }
        Self {
            kind: Some(rpc.kind.clone()),
            text,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn rpc(kind: &str, message: &str, hint: &str) -> ducky_hc::Error {
        ducky_hc::RpcError::from_json(&json!({
            "code": -32000, "message": message, "data": {"kind": kind, "hint": hint}
        }))
        .into()
    }

    #[test]
    fn errors_name_the_problem_then_the_cores_words_and_hint() {
        let error = MachineError::from_hc(rpc(
            "unreachable",
            "cannot reach vps: ssh: Could not resolve hostname vps",
            "check that `ssh vps` logs in without a password prompt",
        ));
        assert_eq!(error.kind.as_deref(), Some("unreachable"));
        assert_eq!(
            error.text,
            "Cannot reach the machine: cannot reach vps: ssh: Could not resolve hostname vps. \
             check that `ssh vps` logs in without a password prompt"
        );
        let taken = MachineError::from_hc(rpc("name_taken", "name_taken", ""));
        assert_eq!(taken.text, "That name is taken");
        let other = MachineError::from_hc(rpc("weird", "something odd", ""));
        assert_eq!(other.text, "something odd");
        let gone = MachineError::from_hc(ducky_hc::Error::Disconnected);
        assert_eq!(gone.kind, None);
    }
}
