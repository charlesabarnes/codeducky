use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// A value as stored, with the fields this build does not know kept for the next write.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Record<T> {
    #[serde(flatten)]
    pub value: T,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl<T> Record<T> {
    pub fn new(value: T) -> Self {
        Self {
            value,
            extra: Map::new(),
        }
    }
}
