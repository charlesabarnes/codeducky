//! Test support (`test-support` feature): an in-process fake GitHub server, and a stateful fake
//! world with one repository and pull request behind it, so write flows (pending reviews, replies,
//! resolving, submitting) can be developed without touching github.com.

mod graphql;
mod rest;
mod server;
mod world;

pub use server::{Call, FakeGitHub, Reply};
pub use world::{Auth, FakeWorld, WorldOptions, Write};
