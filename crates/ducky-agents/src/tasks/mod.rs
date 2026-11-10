//! [`Tasks`]: starting agents and handing them review and fix work.
//!
//! Both calls block: `terminal.run` returns once the program runs (a template launch also waits,
//! up to a minute, for the agent to be ready for its first message), and `terminal.send` waits
//! until nobody has typed into the terminal for ~3 s, then a few seconds more to see whether the
//! agent started working. Call them off the UI thread.

mod delivery;
mod env;
mod naming;
pub mod prompt;
mod task;

use std::collections::BTreeMap;
use std::sync::OnceLock;

use ducky_hc::{Client, ExecParams, Labels, RunParams, SendParams, Size, TemplateInfo, Terminal};
use ducky_terminal::source::DisplayFacts;

pub use delivery::Delivery;
pub use task::{FixError, FixScope, MAX_LISTED, Task, TaskContext};

use crate::directory::machine_of;
use crate::labels;
use crate::source::convert;
use crate::ticket::{TaskKind, TaskTicket};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Program {
    /// An hc template by name (see [`Tasks::templates`]). hc starts its command and, once the
    /// agent reports it is ready, sends the template's instructions plus the task as the first
    /// message.
    Template(String),
    /// A program and its arguments. A first task goes as one more argument, which is how
    /// `claude`, `codex` and `pi` take an opening prompt.
    Command(Vec<String>),
}

#[derive(Debug, Clone)]
pub struct AgentLaunch {
    /// The repo's toplevel on the agent's machine, recorded in the terminal's labels.
    pub repo_root: String,
    pub cwd: String,
    /// Made unique among live terminals and fit to hc's rules.
    pub name: String,
    pub program: Program,
    /// The pane's grid, so the agent draws at the right size before anyone attaches.
    pub size: Option<Size>,
    pub display: Option<DisplayFacts>,
    /// Extra variables; `CLAUDE*` and `HC_*` ones are dropped.
    pub env: BTreeMap<String, String>,
}

impl AgentLaunch {
    pub fn new(repo_root: impl Into<String>, name: impl Into<String>, program: Program) -> Self {
        let repo_root = repo_root.into();
        Self {
            cwd: repo_root.clone(),
            repo_root,
            name: name.into(),
            program,
            size: None,
            display: None,
            env: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Started {
    pub terminal: Terminal,
    /// How the first task fared, when one was given.
    pub first_task: Option<Delivery>,
}

/// Starts agents and sends them tasks on one machine (`None`: the core's own).
pub struct Tasks {
    client: Client,
    machine: Option<String>,
    core_vars: OnceLock<Vec<String>>,
}

impl Tasks {
    pub fn new(client: Client, machine: Option<String>) -> Self {
        Self {
            client,
            machine,
            core_vars: OnceLock::new(),
        }
    }

    pub fn templates(&self) -> ducky_hc::Result<Vec<TemplateInfo>> {
        self.client.templates_list()
    }

    /// Starts an agent, labelled as Code Ducky's. Give the first task here rather than sending
    /// it after: a send to an agent that is still booting can be dropped.
    pub fn start(
        &self,
        launch: &AgentLaunch,
        first_task: Option<(&Task, &TaskContext)>,
    ) -> ducky_hc::Result<Started> {
        let prompt = first_task.map(|(task, context)| prompt::render(task, context));
        let kind = first_task.map(|(task, _)| task.kind());
        let mut argv = match &launch.program {
            Program::Template(name) => vec![name.clone()],
            Program::Command(argv) => argv.clone(),
        };
        argv.extend(prompt);
        let mut taken = self.live_names()?;
        let mut params = RunParams {
            argv,
            cwd: Some(launch.cwd.clone()),
            on: self.machine.clone(),
            name: Some(naming::unique(&launch.name, &taken)),
            env: env::launch_env(self.core_vars(), &launch.env),
            labels: launch_labels(launch, kind),
            display: launch.display.as_ref().map(convert::display),
            size: launch.size,
            no_parent: true,
            ..RunParams::default()
        };
        let terminal = match self.client.terminal_run(&params) {
            Err(error) if error.kind() == Some("name_taken") => {
                taken.extend(params.name.take());
                params.name = Some(naming::unique(&launch.name, &taken));
                self.client.terminal_run(&params)?
            }
            result => result?,
        };
        let first_task = kind.map(|kind| first_delivery(&terminal, &launch.program, kind));
        Ok(Started {
            terminal,
            first_task,
        })
    }

    /// Types the task into a running agent. `force` types even into a blocked agent, which may
    /// answer its dialog with the text; only offer it after the person has seen the screen.
    pub fn send(
        &self,
        terminal: &str,
        task: &Task,
        context: &TaskContext,
        force: bool,
    ) -> Delivery {
        let params = SendParams {
            terminal: terminal.to_owned(),
            text: prompt::render(task, context),
            force,
            ..SendParams::default()
        };
        Delivery::from_send(terminal, task.kind(), self.client.terminal_send(&params))
    }

    fn live_names(&self) -> ducky_hc::Result<Vec<String>> {
        let list = self.client.terminal_list(false, &Labels::new())?;
        Ok(list
            .terminals
            .into_iter()
            .filter(|t| machine_of(&t.address) == self.machine.as_deref())
            .filter_map(|t| t.name)
            .collect())
    }

    /// Names in the environment programs on that machine inherit, read once.
    fn core_vars(&self) -> &[String] {
        self.core_vars.get_or_init(|| {
            let params = ExecParams {
                argv: vec!["env".into()],
                on: self.machine.clone(),
                timeout: Some(10.0),
                ..ExecParams::default()
            };
            self.client
                .exec(&params)
                .map(|out| env::names_in_env_output(&String::from_utf8_lossy(&out.stdout)))
                .unwrap_or_default()
        })
    }
}

fn launch_labels(launch: &AgentLaunch, kind: Option<TaskKind>) -> Labels {
    labels::for_launch(&launch.repo_root, kind.map(TaskKind::as_str))
}

fn first_delivery(terminal: &Terminal, program: &Program, kind: TaskKind) -> Delivery {
    match (program, &terminal.first_message) {
        (Program::Template(_), Some(first)) => {
            Delivery::from_first_message(&terminal.address, kind, first)
        }
        (Program::Template(_), None) => Delivery::Failed {
            reason: "herdr-core did not say whether the first message went in".into(),
        },
        (Program::Command(_), _) => Delivery::Sent {
            ticket: TaskTicket {
                address: terminal.address.clone(),
                kind,
                turn: terminal.turn,
            },
            started: None,
        },
    }
}
