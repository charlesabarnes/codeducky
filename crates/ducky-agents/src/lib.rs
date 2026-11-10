//! Code Ducky's agents: the terminals of herdr-core seen from one repo.
//!
//! - [`HcTerminalSource`] feeds a `ducky_terminal::TerminalView` from an hc terminal.
//! - [`AgentDirectory`] lists the terminals working in a repo and says when their turns end.
//! - [`Tasks`] starts agents and hands them review, fix and custom tasks; the returned
//!   [`Delivery`] carries a [`TaskTicket`] to [`AgentDirectory::track`], which reports
//!   [`DirectoryEvent::Task`] when the agent is done (reload the notes then).
//!
//! Everything blocks or runs on its own threads; nothing here needs an async runtime.

pub mod directory;
mod labels;
pub mod source;
pub mod tasks;
#[cfg(test)]
mod test_support;
mod ticket;

pub use directory::{
    AgentDirectory, AgentInfo, AgentKind, AgentStatus, Connection, DirectoryEvent, DirectoryScope,
};
pub use source::HcTerminalSource;
pub use tasks::{
    AgentLaunch, Delivery, FixError, FixScope, Program, Started, Task, TaskContext, Tasks,
};
pub use ticket::{TaskKind, TaskProgress, TaskTicket, TurnEnd};
