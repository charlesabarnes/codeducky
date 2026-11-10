//! Agents for one review: the repo's terminals, starting agents and handing them tasks, on the
//! machine that holds the checkout. A thin layer over `ducky-agents` that knows the review.

mod command;
mod outcome;
mod recipient;
mod status;

use ducky_agents::{
    AgentDirectory, AgentLaunch, Delivery, DirectoryEvent, DirectoryScope, FixError, FixScope,
    HcTerminalSource, Program, Started, Task, TaskContext, Tasks,
};
use ducky_hc::{Client, Size, TemplateInfo};
use ducky_review::Note;
use std::sync::Arc;

pub use command::split_command;
pub use outcome::{DeliveryOutcome, OutcomeLevel, describe_delivery, describe_progress};
pub use recipient::{Recipient, candidates, default_recipient};
pub use status::{StatusTone, status_text, tone};

use crate::connection::Connection;
use crate::error::{Result, SessionError};
use crate::notes::NotesService;
use crate::review::Review;

/// What to start: a template by name, or a command line.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentRequest {
    pub name: String,
    pub program: Program,
    pub first_task: Option<Task>,
    /// The panel's grid, so the agent draws at the right size before anyone attaches.
    pub size: Option<Size>,
}

#[derive(Clone)]
pub struct AgentsService {
    client: Client,
    machine: Option<String>,
    repo_root: String,
    base: String,
    scope: DirectoryScope,
    notes: NotesService,
    tasks: Arc<Tasks>,
}

impl AgentsService {
    /// Blocks: lists the repo's worktrees, so agents working in any of them show up.
    pub fn for_review(connection: &Connection, review: &Review) -> Result<Self> {
        let client = connection
            .client()
            .ok_or(SessionError::AgentsNeedCore)?
            .clone();
        let machine = review.machine().map(str::to_owned);
        let repo_root = review.toplevel().to_owned();
        let repo = review.repo().ok_or(SessionError::NeedsCheckout)?;
        if let Some(reason) = review
            .pull
            .as_ref()
            .and_then(|p| p.checkout.local_off_reason())
        {
            return Err(SessionError::AgentsOff(reason));
        }
        let worktrees = repo
            .worktrees()
            .map(|list| list.into_iter().map(|w| w.path).collect::<Vec<_>>())
            .unwrap_or_default();
        Ok(Self {
            scope: DirectoryScope::new(machine.clone(), &repo_root).with_worktrees(worktrees),
            tasks: Arc::new(Tasks::new(client.clone(), machine.clone())),
            client,
            machine,
            repo_root,
            base: review.base.clone(),
            notes: review.notes_service().clone(),
        })
    }

    pub fn machine(&self) -> Option<&str> {
        self.machine.as_deref()
    }

    pub fn repo_root(&self) -> &str {
        &self.repo_root
    }

    pub fn scope(&self) -> &DirectoryScope {
        &self.scope
    }

    /// Subscribes to the core's events for this repo's terminals.
    pub fn directory(&self) -> Result<(AgentDirectory, flume::Receiver<DirectoryEvent>)> {
        Ok(AgentDirectory::start(
            self.client.clone(),
            self.scope.clone(),
        )?)
    }

    pub fn templates(&self) -> Result<Vec<TemplateInfo>> {
        Ok(self.tasks.templates()?)
    }

    pub fn context(&self) -> TaskContext {
        TaskContext {
            repo_root: self.repo_root.clone(),
            target: self.notes.target().clone(),
            notes_path: self.notes.notes_path(),
            readme_path: self.notes.readme_path(),
        }
    }

    pub fn review_task(&self) -> Task {
        Task::review(self.base.clone())
    }

    pub fn fix_task(notes: &[Note], scope: &FixScope) -> std::result::Result<Task, FixError> {
        Task::fix(notes, scope)
    }

    /// Starts an agent in the repo root, its first task given at launch.
    pub fn start(&self, request: &AgentRequest) -> Result<Started> {
        if request.first_task.is_some() {
            self.notes.ensure_files()?;
        }
        let mut launch = AgentLaunch::new(&self.repo_root, &request.name, request.program.clone());
        launch.size = request.size;
        let context = self.context();
        let first = request.first_task.as_ref().map(|task| (task, &context));
        Ok(self.tasks.start(&launch, first)?)
    }

    /// `force` types into a blocked agent; only after the person has seen its screen.
    pub fn send(&self, address: &str, task: &Task, force: bool) -> Delivery {
        if let Err(error) = self.notes.ensure_files() {
            return Delivery::Failed {
                reason: format!("could not prepare the notes file: {error}"),
            };
        }
        self.tasks.send(address, task, &self.context(), force)
    }

    /// Removes a finished terminal from the core's list; a live one is refused (`live`).
    pub fn remove(&self, address: &str) -> Result<()> {
        self.client.terminal_rm(address)?;
        Ok(())
    }

    /// The view's source for one of the repo's terminals. Attaching happens when the view
    /// lays out, so only build this for a terminal the person picked.
    pub fn source(&self, address: &str) -> HcTerminalSource {
        HcTerminalSource::new(self.client.clone(), address)
    }
}
