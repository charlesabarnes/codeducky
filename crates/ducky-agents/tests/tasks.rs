//! The task loop against a scratch herdr-core, with a fake agent (`support/fake_agent.py`) in
//! place of a real one: send a task, the agent edits the notes file, its turn ends, the notes
//! reload. Opt in: `-- --ignored`.

mod support;

use std::path::Path;

use ducky_agents::{
    AgentDirectory, AgentLaunch, AgentStatus, Delivery, DirectoryEvent, DirectoryScope, FixScope,
    Program, Task, TaskContext, TaskKind, TaskProgress, TaskTicket, Tasks, TurnEnd,
};
use ducky_hc::scratch::ScratchCore;
use ducky_host::LocalHost;
use ducky_notes::{NotesRepo, ReviewNotes};
use ducky_review::{Anchor, NewNote, NoteId, NoteStatus, ReviewTarget, Severity, Side};
use support::{eventually, fake_agent, git_repo, path_str, receive};

struct Fixture {
    core: ScratchCore,
    repo: String,
    notes_repo: NotesRepo,
    review: ReviewNotes,
    directory: AgentDirectory,
    events: flume::Receiver<DirectoryEvent>,
    tasks: Tasks,
}

impl Fixture {
    fn new(tag: &str, core_env: &[(&str, &str)]) -> Self {
        let core = ScratchCore::start_with_env(tag, core_env).unwrap();
        let repo = path_str(&git_repo(core.root()));
        let notes_repo = NotesRepo::open(&LocalHost, &repo).unwrap();
        let review = notes_repo
            .review(ReviewTarget::branch("feature/x"))
            .unwrap();
        review.insert_notes(&LocalHost, Vec::new()).unwrap();
        let client = core.client().unwrap();
        let (directory, events) =
            AgentDirectory::start(client.clone(), DirectoryScope::new(None, &repo)).unwrap();
        Self {
            tasks: Tasks::new(client, None),
            core,
            repo,
            notes_repo,
            review,
            directory,
            events,
        }
    }

    fn context(&self) -> TaskContext {
        TaskContext::new(&self.repo, &self.notes_repo, &self.review)
    }

    fn note(&self, severity: Severity, line: u32, body: &str) -> NoteId {
        let mut new = NewNote::new("cart.rs", Anchor::at_line(Side::New, line, None), body);
        new.severity = severity;
        self.review.add_note(&LocalHost, new).unwrap().id
    }

    fn start_fake(&self, name: &str) -> String {
        let launch = AgentLaunch::new(&self.repo, name, Program::Command(fake_agent()));
        let started = self.tasks.start(&launch, None).unwrap();
        let address = started.terminal.address;
        eventually("the fake agent to be ready", || {
            self.directory
                .agent(&address)
                .filter(|a| a.status == AgentStatus::Idle)
        });
        address
    }

    fn finished(&self, ticket: &TaskTicket) -> TurnEnd {
        receive(&self.events, "the task to finish", |event| match event {
            DirectoryEvent::Task {
                ticket: t,
                progress: TaskProgress::Finished(end),
            } if t.address == ticket.address => Some(end.clone()),
            _ => None,
        })
    }
}

#[test]
#[ignore = "starts a scratch herdr-core"]
fn a_fix_task_resolves_the_selected_notes_and_the_reload_shows_it() {
    let f = Fixture::new("tf", &[]);
    let blocker = f.note(Severity::Blocker, 1, "`total` ignores the discount.");
    let nit = f.note(Severity::Nit, 1, "Name it `cart_total`.");
    let agent = f.start_fake("Fix notes");

    let info = f.directory.agent(&agent).unwrap();
    assert!(info.started_by_ducky);
    assert_eq!(info.name.as_deref(), Some("fix-notes"));
    assert_eq!(info.where_label.as_deref(), Some("Code Ducky / repo"));

    let notes = f.review.notes(&LocalHost).unwrap();
    let task = Task::fix(&notes, &FixScope::Selected(vec![blocker.clone()])).unwrap();
    let delivery = f.tasks.send(&agent, &task, &f.context(), false);
    let Delivery::Sent { ticket, started } = &delivery else {
        panic!("{delivery:?}");
    };
    assert_eq!(*started, Some(true));
    assert_eq!(ticket.kind, TaskKind::Fix);
    f.directory.track(ticket.clone());
    assert_eq!(f.finished(ticket), TurnEnd::Done);

    let reloaded = f.review.notes(&LocalHost).unwrap();
    let fixed = reloaded.iter().find(|n| n.id == blocker).unwrap();
    assert_eq!(fixed.status, NoteStatus::Resolved);
    assert_eq!(
        fixed.resolution.as_ref().unwrap().text,
        "fake agent fixed it"
    );
    let left = reloaded.iter().find(|n| n.id == nit).unwrap();
    assert_eq!(left.status, NoteStatus::Open);
    assert!(f.directory.tracked().is_empty());
}

#[test]
#[ignore = "starts a scratch herdr-core"]
fn a_review_as_the_first_task_of_a_template_launch_adds_a_note() {
    let f = Fixture::new("tr", &[]);
    let templates = f.core.config_dir().join("templates");
    std::fs::create_dir_all(&templates).unwrap();
    let command = fake_agent().join(" ");
    std::fs::write(
        templates.join("fakeagent.md"),
        format!(
            "---\nname: fakeagent\ndescription: A fake agent for tests\ncommand: {command}\n---\nYou are a fake agent.\n"
        ),
    )
    .unwrap();
    let listed = f.tasks.templates().unwrap();
    assert!(listed.iter().any(|t| t.name == "fakeagent"), "{listed:?}");

    let launch = AgentLaunch::new(&f.repo, "review", Program::Template("fakeagent".into()));
    let started = f
        .tasks
        .start(&launch, Some((&Task::review("main"), &f.context())))
        .unwrap();
    let delivery = started.first_task.unwrap();
    let Delivery::Sent { ticket, .. } = &delivery else {
        panic!("{delivery:?}");
    };
    f.directory.track(ticket.clone());
    assert_eq!(f.finished(ticket), TurnEnd::Done);
    let notes = f.review.notes(&LocalHost).unwrap();
    assert!(
        notes.iter().any(|n| n.id.as_str() == "fake01"),
        "{notes:#?}"
    );
    assert_eq!(
        started
            .terminal
            .labels
            .get("codeducky-task")
            .map(String::as_str),
        Some("review")
    );
}

#[test]
#[ignore = "starts a scratch herdr-core"]
fn a_blocked_agent_refuses_a_task_unless_forced() {
    let f = Fixture::new("tb", &[]);
    let agent = f.start_fake("blocky");
    let context = f.context();
    let block = f
        .tasks
        .send(&agent, &Task::custom("block"), &context, false);
    assert!(
        matches!(block, Delivery::NotStarted { .. }),
        "it blocks without ever working: {block:?}"
    );
    eventually("the agent to block", || {
        f.directory
            .agent(&agent)
            .filter(|a| matches!(a.status, AgentStatus::Blocked { .. }))
    });

    let task = Task::review("main");
    assert_eq!(
        f.tasks.send(&agent, &task, &context, false),
        Delivery::RefusedBlocked
    );
    let forced = f.tasks.send(&agent, &task, &context, true);
    let ticket = forced.ticket().unwrap().clone();
    f.directory.track(ticket.clone());
    assert_eq!(f.finished(&ticket), TurnEnd::Done);

    let exit = f.tasks.send(&agent, &Task::custom("exit"), &context, false);
    f.directory.track(exit.ticket().unwrap().clone());
    assert_eq!(
        f.finished(exit.ticket().unwrap()),
        TurnEnd::Exited { code: Some(3) }
    );
    assert!(matches!(
        f.tasks.send(&agent, &task, &context, false),
        Delivery::Failed { .. }
    ));
}

#[test]
#[ignore = "starts a scratch herdr-core"]
fn agents_start_without_a_parent_sessions_markers() {
    let f = Fixture::new(
        "te",
        &[("CLAUDECODE", "1"), ("CLAUDE_CONFIG_DIR", "/keep/me")],
    );
    let agent = f.start_fake("envcheck");
    let client = f.core.client().unwrap();
    let screen = client.terminal_read(&agent, 0).unwrap().text;
    assert!(screen.contains("fake agent ready [][/keep/me]"), "{screen}");
    assert!(Path::new(&f.context().readme_path).exists());
}
