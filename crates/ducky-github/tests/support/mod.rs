//! The fake GitHub lives in the crate behind `test-support`; fixtures stay here.

#![allow(dead_code)]

pub use ducky_github::fake::{FakeGitHub, Reply};
use serde_json::Value;

pub fn fixture(name: &str) -> Value {
    serde_json::from_str(&fixture_text(name)).expect("fixture json")
}

pub fn fixture_text(name: &str) -> String {
    std::fs::read_to_string(format!(
        "{}/tests/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .expect("fixture")
}
