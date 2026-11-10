//! The agents and machines services against scratch herdr-cores, never the live one, with the
//! fake agent from ducky-agents in place of a real one. Opt in: `-- --ignored`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use ducky_agents::{
    AgentStatus, Delivery, DirectoryEvent, FixScope, Program, TaskProgress, TurnEnd,
};
use ducky_hc::scratch::ScratchCore;
use ducky_review::{NoteStatus, Severity, Side};
use ducky_session::agents::{AgentRequest, AgentsService, Recipient, default_recipient};
use ducky_session::machines::{MachineState, MachinesService, NewMachine};
use ducky_session::{
    Connection, CoreTarget, NoteDraft, Review, ReviewRequest, changed_notes, list_folders,
};

const TIMEOUT: Duration = Duration::from_secs(30);

fn fake_agent() -> Program {
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../ducky-agents/tests/support/fake_agent.py");
    Program::Command(vec![
        "python3".into(),
        script.to_string_lossy().into_owned(),
    ])
}

fn git_repo(root: &Path) -> PathBuf {
    let repo = root.join("shop");
    std::fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| {
        let out = Command::new("git")
            .args([
                "-c",
                "user.name=T",
                "-c",
                "user.email=t@x",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(&repo)
            .output()
            .unwrap();
        assert!(out.status.success(), "{out:?}");
    };
    git(&["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("README.md"), "hello\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "base"]);
    git(&["checkout", "-q", "-b", "feature/cart"]);
    std::fs::write(repo.join("cart.rs"), "fn total() -> u32 {\n    1\n}\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "cart"]);
    repo.canonicalize().unwrap()
}

fn eventually<T>(what: &str, mut check: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        if let Some(value) = check() {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn connect(core: &ScratchCore) -> Connection {
    let connection = Connection::connect_to(CoreTarget::Socket(core.socket().to_owned()));
    assert!(
        !connection.state().is_local_only(),
        "{:?}",
        connection.state()
    );
    connection
}

fn start_fake(
    service: &AgentsService,
    directory: &ducky_agents::AgentDirectory,
    name: &str,
) -> String {
    let started = service
        .start(&AgentRequest {
            name: name.into(),
            program: fake_agent(),
            first_task: None,
            size: None,
        })
        .unwrap();
    let address = started.terminal.address;
    eventually("the fake agent to be idle", || {
        directory
            .agent(&address)
            .filter(|a| a.status == AgentStatus::Idle)
    });
    address
}

fn wait_finished(events: &flume::Receiver<DirectoryEvent>, address: &str) -> TurnEnd {
    let deadline = Instant::now() + TIMEOUT;
    while let Ok(event) = events.recv_deadline(deadline) {
        if let DirectoryEvent::Task {
            ticket,
            progress: TaskProgress::Finished(end),
        } = event
            && ticket.address == address
        {
            return end;
        }
    }
    panic!("the task did not finish");
}

#[test]
#[ignore = "starts a scratch herdr-core"]
fn a_fix_hand_off_resolves_the_note_and_the_reload_marks_it_changed() {
    let core = ScratchCore::start("sa").unwrap();
    let repo = git_repo(core.root());
    let connection = connect(&core);
    let review = Review::open(
        &connection,
        ReviewRequest::local(repo.to_string_lossy().into_owned()),
    )
    .unwrap();
    let service = AgentsService::for_review(&connection, &review).unwrap();
    let (directory, events) = service.directory().unwrap();
    assert!(directory.agents().is_empty());
    let lines = Review::load_diff(&review, "cart.rs", Default::default())
        .unwrap()
        .side_lines(Side::New)
        .unwrap()
        .to_vec();
    let note = review
        .notes_service()
        .add(
            NoteDraft {
                path: "cart.rs".into(),
                side: Side::New,
                line: 2,
                end_line: None,
                body: "Apply the discount.".into(),
                severity: Severity::Issue,
            },
            &lines,
        )
        .unwrap();
    let before = review.notes_service().notes().unwrap();

    let address = start_fake(&service, &directory, "fixer");
    assert_eq!(
        default_recipient(&directory.agents(), &[]),
        Recipient::Agent(address.clone())
    );
    let task = AgentsService::fix_task(&before, &FixScope::AllOpen).unwrap();
    let delivery = service.send(&address, &task, false);
    let Delivery::Sent { ticket, .. } = &delivery else {
        panic!("{delivery:?}");
    };
    directory.track(ticket.clone());
    assert_eq!(wait_finished(&events, &address), TurnEnd::Done);

    let after = review.notes_service().notes().unwrap();
    let fixed = after.iter().find(|n| n.id == note.id).unwrap();
    assert_eq!(fixed.status, NoteStatus::Resolved);
    assert!(changed_notes(&before, &after).contains(&note.id));
    assert!(Path::new(&review.notes_service().readme_path()).exists());
}

#[test]
#[ignore = "starts a scratch herdr-core"]
fn a_review_as_first_task_and_a_blocked_agent() {
    let core = ScratchCore::start("sb").unwrap();
    let repo = git_repo(core.root());
    let connection = connect(&core);
    let review = Review::open(
        &connection,
        ReviewRequest::local(repo.to_string_lossy().into_owned()),
    )
    .unwrap();
    let service = AgentsService::for_review(&connection, &review).unwrap();
    let (directory, events) = service.directory().unwrap();
    let Program::Command(argv) = fake_agent() else {
        unreachable!()
    };
    let templates = core.config_dir().join("templates");
    std::fs::create_dir_all(&templates).unwrap();
    std::fs::write(
        templates.join("fakeagent.md"),
        format!(
            "---\nname: fakeagent\ndescription: A fake agent\ncommand: {}\n---\nYou are fake.\n",
            argv.join(" ")
        ),
    )
    .unwrap();
    assert!(
        service
            .templates()
            .unwrap()
            .iter()
            .any(|t| t.name == "fakeagent")
    );
    let started = service
        .start(&AgentRequest {
            name: "Reviewer".into(),
            program: Program::Template("fakeagent".into()),
            first_task: Some(service.review_task()),
            size: Some(ducky_hc::Size {
                cols: 100,
                rows: 30,
            }),
        })
        .unwrap();
    let delivery = started.first_task.unwrap();
    directory.track(delivery.ticket().unwrap().clone());
    let address = started.terminal.address;
    assert_eq!(wait_finished(&events, &address), TurnEnd::Done);
    let notes = review.notes_service().notes().unwrap();
    assert!(notes.iter().any(|n| n.author.is_agent()), "{notes:#?}");

    let blocky = start_fake(&service, &directory, "blocky");
    service.send(&blocky, &ducky_agents::Task::custom("block"), false);
    eventually("the agent to block", || {
        directory
            .agent(&blocky)
            .filter(|a| matches!(a.status, AgentStatus::Blocked { .. }))
    });
    assert_eq!(
        service.send(&blocky, &service.review_task(), false),
        Delivery::RefusedBlocked
    );
}

#[test]
#[ignore = "starts scratch herdr-cores"]
fn machines_are_added_renamed_and_forgotten_and_remote_repos_open() {
    // Dropped after `core`: a home core still dialling it would start it again.
    let other = ScratchCore::start("so").unwrap();
    let core = ScratchCore::start("sm").unwrap();
    let repo = git_repo(other.root());
    let connection = connect(&core);
    let machines = MachinesService::new(&connection).unwrap();
    assert!(machines.list().unwrap().is_empty());

    let refused = machines
        .add(&NewMachine {
            target: String::new(),
            name: Some("nope".into()),
            via: Some("false".into()),
        })
        .unwrap_err();
    assert_eq!(refused.kind.as_deref(), Some("unreachable"));
    assert!(
        refused.text.starts_with("Cannot reach the machine"),
        "{refused}"
    );

    let via = format!("{} ", other.via_command().unwrap());
    let added = machines
        .add(&NewMachine {
            target: String::new(),
            name: Some("box".into()),
            via: Some(via.trim().to_owned()),
        })
        .unwrap();
    assert_eq!(added.name, "box");
    eventually("the machine to connect", || {
        machines
            .list()
            .unwrap()
            .into_iter()
            .find(|m| m.name == "box" && m.state == MachineState::Connected)
    });
    let renamed = machines.rename("box", "lab").unwrap();
    assert_eq!(renamed.name, "lab");
    assert!(machines.reconnect("lab").unwrap().state.is_connected());
    assert_eq!(
        machines.rename("nowhere", "x").unwrap_err().kind.as_deref(),
        Some("machine_unknown")
    );

    let host = connection.host(Some("lab")).unwrap();
    let listing = list_folders(&*host, &other.root().to_string_lossy()).unwrap();
    assert!(
        listing
            .folders
            .iter()
            .any(|f| f.name == "shop" && f.is_repo)
    );

    let review = Review::open(
        &connection,
        ReviewRequest {
            path: repo.to_string_lossy().into_owned(),
            machine: Some("lab".into()),
            base: None,
        },
    )
    .unwrap();
    assert_eq!(review.files.len(), 1);
    let service = AgentsService::for_review(&connection, &review).unwrap();
    let (directory, _events) = service.directory().unwrap();
    let address = start_fake(&service, &directory, "remote");
    assert!(address.starts_with("lab/"), "{address}");

    machines.remove("lab").unwrap();
    assert!(machines.list().unwrap().is_empty());
}
