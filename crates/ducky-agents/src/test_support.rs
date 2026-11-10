use ducky_hc::Terminal;
use serde_json::{Value, json};

/// A live terminal record at `/repo`, with `extra` fields replaced.
pub fn terminal(extra: Value) -> Terminal {
    let mut record = json!({
        "address": "t1", "argv": ["/bin/zsh", "-l"], "cwd": "/repo", "state": "live",
        "labels": {}, "created_ms": 1, "cols": 80, "rows": 24, "screen": "exact",
    });
    for (key, value) in extra.as_object().expect("an object") {
        record[key] = value.clone();
    }
    serde_json::from_value(record).expect("a terminal record")
}
