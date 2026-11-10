use std::fmt;

use serde::{Deserialize, Serialize};

/// What is under review: a local branch against its base, or a GitHub pull request.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReviewTarget {
    Branch { branch: String },
    PullRequest { number: u64 },
}

impl ReviewTarget {
    pub fn branch(name: impl Into<String>) -> Self {
        Self::Branch {
            branch: name.into(),
        }
    }

    pub fn pull_request(number: u64) -> Self {
        Self::PullRequest { number }
    }
}

impl fmt::Display for ReviewTarget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Branch { branch } => write!(f, "branch {branch}"),
            Self::PullRequest { number } => write!(f, "pull request #{number}"),
        }
    }
}
