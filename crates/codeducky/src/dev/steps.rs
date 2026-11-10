//! Dev scripting for agents and machines. Everything that starts, attaches to or sends to a
//! terminal needs `--scratch` or `--hc-socket`, so a scripted run never touches the live core's
//! terminals.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use ducky_agents::{AgentStatus, FixScope, Program, Task};
use ducky_review::NoteId;
use ducky_session::CoreTarget;
use ducky_session::agents::{AgentRequest, AgentsService, split_command};
use ducky_session::machines::NewMachine;
use gpui_kit::*;

use super::scratch;
use super::script::fail;
use crate::config::Prefs;
use crate::state::agents::Line;
use crate::state::{AgentsModel, ReviewModel};
use crate::views::agents::Ask;
use crate::views::workspace::Workspace;

const TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
enum TaskStep {
    Fix,
    Review,
    Message(String),
}

#[derive(Debug, Default)]
pub struct Steps {
    hc_socket: Option<PathBuf>,
    scratch: bool,
    scratch_machine: Option<String>,
    scratch_templates: Vec<String>,
    machine_via: Option<(String, String)>,
    panel: Option<bool>,
    panel_height: Option<f32>,
    agent_command: Option<String>,
    start_agents: Vec<String>,
    check_notes: Vec<String>,
    tasks: Vec<(String, TaskStep)>,
    force: bool,
    wait_task: bool,
    select_agent: Option<String>,
    agent_type: Option<String>,
    ask: Option<Ask>,
    start_dialog: bool,
    add_machine_dialog: bool,
    add_machine_target: Option<String>,
    machine_menu: bool,
    rename_machine: Option<String>,
    forget_machine: Option<String>,
    browse_machine: Option<String>,
    browse_path: Option<String>,
    focus_terminal: bool,
    stop_core: bool,
}

impl Steps {
    /// Takes a flag this module knows; `false` for any other.
    pub fn parse(&mut self, flag: &str, value: &mut dyn FnMut() -> String) -> bool {
        match flag {
            "--hc-socket" => self.hc_socket = Some(PathBuf::from(value())),
            "--scratch" => self.scratch = true,
            "--scratch-machine" => self.scratch_machine = Some(value()),
            "--scratch-template" => self.scratch_templates.push(value()),
            "--panel" => self.panel = Some(true),
            "--panel-height" => {
                let v = value();
                self.panel_height = Some(
                    v.parse()
                        .unwrap_or_else(|_| fail(format!("--panel-height: {v}"))),
                );
            }
            "--agent-command" => self.agent_command = Some(value()),
            "--start-agent" => self.start_agents.push(value()),
            "--check-note" => self.check_notes.push(value()),
            "--task" => {
                let v = value();
                let (agent, kind) = v.split_once('=').unwrap_or_else(|| {
                    fail(format!("--task wants <agent>=fix|review|msg:<text>: {v}"))
                });
                let step = match kind.split_once(':') {
                    Some(("msg", text)) => TaskStep::Message(text.to_owned()),
                    None if kind == "fix" => TaskStep::Fix,
                    None if kind == "review" => TaskStep::Review,
                    _ => fail(format!("--task: unknown task {kind}")),
                };
                self.tasks.push((agent.to_owned(), step));
            }
            "--force" => self.force = true,
            "--wait-task" => self.wait_task = true,
            "--agent" => self.select_agent = Some(value()),
            "--agent-type" => self.agent_type = Some(value()),
            "--ask" => {
                let v = value();
                self.ask = Some(match v.as_str() {
                    "review" => Ask::Review,
                    "fix" => Ask::Fix,
                    "message" => Ask::Message,
                    _ => fail(format!("--ask: unknown {v}")),
                });
            }
            "--start-dialog" => self.start_dialog = true,
            "--add-machine-dialog" => self.add_machine_dialog = true,
            "--add-machine-target" => self.add_machine_target = Some(value()),
            "--machine-menu" => self.machine_menu = true,
            "--rename-machine" => self.rename_machine = Some(value()),
            "--forget-machine" => self.forget_machine = Some(value()),
            "--browse-machine" => self.browse_machine = Some(value()),
            "--browse-path" => self.browse_path = Some(value()),
            "--focus-terminal" => self.focus_terminal = true,
            "--stop-core" => self.stop_core = true,
            _ => return false,
        }
        true
    }

    fn touches_terminals(&self) -> bool {
        !self.start_agents.is_empty()
            || !self.tasks.is_empty()
            || self.select_agent.is_some()
            || self.agent_type.is_some()
            || self.ask.is_some()
            || self.focus_terminal
            || self.scratch_machine.is_some()
            || self.forget_machine.is_some()
            || self.rename_machine.is_some()
    }

    pub fn apply_prefs(&self, prefs: &mut Prefs) {
        if let Some(open) = self.panel {
            prefs.agents.open = open;
        }
        if let Some(height) = self.panel_height {
            prefs.agents.height = height;
        }
        if let Some(command) = &self.agent_command {
            prefs.agent_command = command.clone();
        }
    }

    /// Which core to use; starts the scratch cores. Refuses terminal work on the live core.
    pub fn core_target(&mut self) -> Option<CoreTarget> {
        let target = if self.scratch {
            let (socket, _, _) = scratch::start("app").unwrap_or_else(|e| fail(e));
            Some(CoreTarget::Socket(socket))
        } else {
            self.hc_socket.clone().map(CoreTarget::Socket)
        };
        if target.is_none() && self.touches_terminals() {
            fail(
                "agent and machine steps need --scratch or --hc-socket (never the live core)"
                    .into(),
            );
        }
        for spec in &self.scratch_templates {
            let (name, command) = spec.split_once('=').unwrap_or_else(|| {
                fail(format!("--scratch-template wants <name>=<command>: {spec}"))
            });
            scratch::add_template(name, command).unwrap_or_else(|e| fail(e));
        }
        if self.scratch_machine.is_some() {
            let (_, via, session) = scratch::start("mc").unwrap_or_else(|e| fail(e));
            self.machine_via = Some((via, session));
        }
        target
    }

    pub async fn before_open(&self, workspace: &Entity<Workspace>, cx: &mut AsyncApp) {
        let (Some(name), Some((via, _))) = (&self.scratch_machine, &self.machine_via) else {
            return;
        };
        let new = NewMachine {
            target: String::new(),
            name: Some(name.clone()),
            via: Some(via.clone()),
        };
        let task = cx.update(|cx| {
            workspace.update(cx, |ws, cx| ws.machines.update(cx, |m, cx| m.add(new, cx)))
        });
        match task.await {
            Ok(entry) => eprintln!("machine {} added: {}", entry.name, entry.state.label()),
            Err(error) => fail(format!("adding the scratch machine: {error}")),
        }
        wait(cx, "the machine list", |cx| {
            let m = workspace.read(cx).machines.read(cx);
            m.busy.is_none() && m.entry(name).is_some_and(|e| e.state.is_connected())
        })
        .await;
    }

    pub async fn after_open(
        &self,
        window: AnyWindowHandle,
        workspace: &Entity<Workspace>,
        cx: &mut AsyncApp,
    ) {
        let agents = cx.update(|cx| workspace.read(cx).agents.clone());
        let model = cx.update(|cx| workspace.read(cx).model.clone());
        let reviewing = cx.update(|cx| model.read(cx).review.is_some());
        if reviewing && self.touches_terminals() {
            wait(cx, "the agents panel", |cx| {
                let a = agents.read(cx);
                a.line == Line::Ready && a.is_ready()
            })
            .await;
        }
        for name in &self.start_agents {
            self.start_agent(name, &agents, cx).await;
        }
        if !self.check_notes.is_empty() {
            cx.update(|cx| {
                model.update(cx, |m, cx| {
                    for id in &self.check_notes {
                        m.toggle_fix_selection(NoteId::new(id.clone()), cx);
                    }
                })
            });
        }
        let mut sent = Vec::new();
        for (name, step) in &self.tasks {
            let address = address_of(&agents, name, cx);
            let task = cx.update(|cx| task_for(step, &model, &agents, cx));
            cx.update(|cx| {
                agents.update(cx, |a, cx| a.send(address.clone(), task, self.force, cx))
            });
            wait(cx, "the hand-off", |cx| agents.read(cx).is_ready()).await;
            let toast = cx.update(|cx| workspace.read(cx).last_toast.clone());
            eprintln!("hand-off to {name}: {}", toast.unwrap_or_default());
            sent.push(address);
        }
        if self.wait_task {
            let started = Instant::now();
            wait(cx, "the tasks to finish", |cx| {
                let a = agents.read(cx);
                sent.iter().all(|address| {
                    a.marks
                        .get(address)
                        .and_then(|m| m.task.as_deref())
                        .is_some_and(|t| t.contains(':'))
                })
            })
            .await;
            wait(cx, "the notes to reload", |cx| model.read(cx).is_ready()).await;
            eprintln!("tasks finished after {:?}", started.elapsed());
        }
        if let Some(name) = &self.select_agent {
            let address = address_of(&agents, name, cx);
            cx.update(|cx| agents.update(cx, |a, cx| a.select(Some(address), cx)));
        }
        let ui =
            |cx: &mut AsyncApp,
             f: &dyn Fn(&mut Workspace, &mut Window, &mut Context<Workspace>)| {
                window
                    .update(cx, |_, window, cx| {
                        workspace.update(cx, |ws, cx| f(ws, window, cx))
                    })
                    .ok();
            };
        if let Some(text) = &self.agent_type {
            settle(cx).await;
            let text = text.replace("\\r", "\r");
            ui(cx, &|ws, _, cx| {
                if let Some(shown) = &ws.panel.read(cx).shown {
                    let view = shown.view.clone();
                    view.update(cx, |v, cx| v.send_text(&text, cx));
                }
            });
        }
        if self.focus_terminal {
            settle(cx).await;
            ui(cx, &|ws, window, cx| ws.focus_terminal(window, cx));
        }
        if let Some(ask) = self.ask {
            ui(cx, &|ws, window, cx| ws.ask(ask, window, cx));
            wait(cx, "the hand-off", |cx| agents.read(cx).is_ready()).await;
        }
        if self.start_dialog {
            ui(cx, &|ws, window, cx| ws.open_start_dialog(None, window, cx));
        }
        if self.add_machine_dialog {
            ui(cx, &|ws, window, cx| ws.open_add_machine(window, cx));
            if let Some(target) = &self.add_machine_target {
                ui(cx, &|ws, window, cx| {
                    if let Some(crate::views::workspace::Dialog::AddMachine(d)) = &ws.dialog {
                        let target = target.clone();
                        d.update(cx, |d, cx| {
                            d.target
                                .update(cx, |input, cx| input.set_value(target, window, cx))
                        });
                    }
                });
            }
        }
        if let Some(name) = &self.rename_machine {
            ui(cx, &|ws, window, cx| {
                ws.open_rename_machine(name.clone(), window, cx)
            });
        }
        if let Some(name) = &self.forget_machine {
            ui(cx, &|ws, _, cx| {
                ws.machines.update(cx, |m, cx| {
                    m.confirm_remove = Some(name.clone());
                    cx.notify();
                })
            });
        }
        if self.stop_core {
            scratch::stop_first();
            wait(cx, "the disconnect", |cx| {
                matches!(agents.read(cx).line, Line::Disconnected { .. })
            })
            .await;
        }
        if self.machine_menu {
            ui(cx, &|ws, _, cx| {
                ws.show_machine_menu = true;
                cx.notify();
            });
        }
        if let Some(machine) = &self.browse_machine {
            let path = self.browse_path.clone().unwrap_or_default();
            ui(cx, &|ws, window, cx| {
                ws.browse_on(machine.clone(), path.clone(), window, cx)
            });
            settle(cx).await;
        }
    }

    /// `name` or `name=command`; the command defaults to `--agent-command`.
    async fn start_agent(&self, spec: &str, agents: &Entity<AgentsModel>, cx: &mut AsyncApp) {
        let (name, command) = match spec.split_once('=') {
            Some((name, command)) => (name, command.to_owned()),
            None => (
                spec,
                self.agent_command
                    .clone()
                    .unwrap_or_else(|| "claude".into()),
            ),
        };
        if !command.contains("fake_agent")
            && !command.starts_with("/bin/")
            && !command.starts_with("sh")
        {
            fail(format!(
                "dev runs only start the fake agent or a shell, not {command:?}"
            ));
        }
        let argv = split_command(&command).unwrap_or_else(|e| fail(e));
        let request = AgentRequest {
            name: name.to_owned(),
            program: Program::Command(argv),
            first_task: None,
            size: None,
        };
        cx.update(|cx| agents.update(cx, |a, cx| a.start(request, cx)));
        wait(cx, &format!("{name} to start"), |cx| {
            let a = agents.read(cx);
            a.is_ready()
                && a.agents.iter().any(|agent| {
                    agent.name.as_deref() == Some(name)
                        && (agent.status == AgentStatus::Idle || command.starts_with("/bin/"))
                })
        })
        .await;
    }
}

fn address_of(agents: &Entity<AgentsModel>, name: &str, cx: &mut AsyncApp) -> String {
    cx.update(|cx| {
        agents
            .read(cx)
            .agents
            .iter()
            .find(|a| a.name.as_deref() == Some(name))
            .map(|a| a.address.clone())
            .unwrap_or_else(|| fail(format!("no agent named {name}")))
    })
}

fn task_for(
    step: &TaskStep,
    model: &Entity<ReviewModel>,
    agents: &Entity<AgentsModel>,
    cx: &App,
) -> Task {
    match step {
        TaskStep::Message(text) => Task::custom(text.clone()),
        TaskStep::Review => agents
            .read(cx)
            .service()
            .map(AgentsService::review_task)
            .unwrap_or_else(|| fail("agents are not available".into())),
        TaskStep::Fix => {
            let m = model.read(cx);
            let notes = m
                .review
                .as_ref()
                .map(|r| r.notes.clone())
                .unwrap_or_default();
            let scope = if m.fix_selection.is_empty() {
                FixScope::AllOpen
            } else {
                FixScope::Selected(m.fix_selection.iter().cloned().collect())
            };
            AgentsService::fix_task(&notes, &scope).unwrap_or_else(|e| fail(e.to_string()))
        }
    }
}

async fn settle(cx: &mut AsyncApp) {
    cx.background_executor()
        .timer(Duration::from_millis(600))
        .await;
}

async fn wait(cx: &mut AsyncApp, what: &str, done: impl Fn(&App) -> bool) {
    let start = Instant::now();
    loop {
        cx.background_executor()
            .timer(Duration::from_millis(50))
            .await;
        if cx.update(|cx| done(cx)) {
            return;
        }
        if start.elapsed() > TIMEOUT {
            fail(format!("{what}: timed out"));
        }
    }
}
