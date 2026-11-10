use serde::{Deserialize, Serialize};

/// The side of a diff: the base (`old`, GitHub's LEFT) or the change (`new`, RIGHT).
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Old,
    #[default]
    New,
}

impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Old => "old",
            Self::New => "new",
        }
    }
}
