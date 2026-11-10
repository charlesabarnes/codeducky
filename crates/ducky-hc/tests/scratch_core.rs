//! Against a real herdr-core that each test starts for itself and stops again (see
//! `ducky_hc::scratch`), so the user's live core is never involved.
//! Opt in: `cargo test -p ducky-hc -- --ignored`.

use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use ducky_hc::scratch::ScratchCore;
use ducky_hc::{
    AttachParams, EventKind, EventMessage, HcHost, RunParams, SendParams, Size, StreamEvent,
    SubscribeParams,
};
use ducky_host::{ExecRequest, Host, HostError};

#[test]
#[ignore = "starts a scratch herdr-core"]
fn exec_and_byte_exact_files() {
    let core = ScratchCore::start("f").unwrap();
    let client = core.client().unwrap();
    let status = client.server_status().unwrap();
    assert_eq!(status.version, client.hello().version);

    let host = HcHost::new(client, None);
    let output = host
        .exec(ExecRequest::new(["sh", "-c", "cat; echo err >&2; exit 4"]).stdin("in"))
        .unwrap();
    assert_eq!(output.status, Some(4));
    assert_eq!(output.stdout, b"in");
    assert_eq!(output.stderr, b"err\n");

    let timed = host
        .exec(ExecRequest::new(["sleep", "5"]).timeout(Duration::from_millis(300)))
        .unwrap();
    assert!(timed.timed_out);

    assert!(matches!(
        host.exec(ExecRequest::new(["no-such-program-xyz"])),
        Err(HostError::NotFound(_))
    ));

    let root = core.root().join("files");
    let path = |name: &str| root.join(name).to_str().unwrap().to_owned();
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("empty", vec![]),
        ("crlf.txt", b"one\r\ntwo\r\n".to_vec()),
        ("no-newline.txt", "naïve café".as_bytes().to_vec()),
        ("bin", vec![0, 255, 10, 13, 0x80, 0xfe]),
        ("nested/dir/notes.json", b"{\"a\":1}\n".to_vec()),
    ];
    for (name, bytes) in &cases {
        host.write_file(&path(name), bytes).unwrap();
        assert_eq!(&std::fs::read(path(name)).unwrap(), bytes, "{name} on disk");
        assert_eq!(&host.read_file(&path(name)).unwrap(), bytes, "{name} read");
    }

    let large: Vec<u8> = (0..(9 << 20) + 12_345)
        .map(|i: usize| (i.wrapping_mul(2_654_435_761) >> 13) as u8)
        .collect();
    host.write_file(&path("large.bin"), &large).unwrap();
    assert!(std::fs::read(path("large.bin")).unwrap() == large);
    assert!(host.read_file(&path("large.bin")).unwrap() == large);
    assert!(!Path::new(&format!("{}.ducky-tmp", path("large.bin"))).exists());

    let lines: String = (0..400_000).map(|i| format!("line {i}\n")).collect();
    std::fs::write(path("many-lines.txt"), &lines).unwrap();
    assert!(host.read_file(&path("many-lines.txt")).unwrap() == lines.as_bytes());

    assert!(matches!(
        host.read_file(&path("missing")),
        Err(HostError::NotFound(_))
    ));
}

#[test]
#[ignore = "starts a scratch herdr-core"]
fn terminals_events_and_attach() {
    let core = ScratchCore::start("t").unwrap();
    let client = core.client().unwrap();
    let mut events = client.subscribe(&SubscribeParams::default()).unwrap();
    assert!(events.snapshot().terminals.is_empty());

    let terminal = client
        .terminal_run(&RunParams {
            argv: vec!["/bin/sh".into()],
            name: Some("duck".into()),
            env: [("PS1".into(), "$ ".into())].into(),
            size: Some(Size { cols: 80, rows: 24 }),
            no_parent: true,
            labels: [("app".into(), "codeducky".into())].into(),
            ..RunParams::default()
        })
        .unwrap();
    let address = terminal.address.clone();
    assert_eq!(terminal.name.as_deref(), Some("duck"));
    wait_for_event(&mut events, &address, EventKind::Created);

    let listed = client
        .terminal_list(false, &[("app".into(), "codeducky".into())].into())
        .unwrap();
    assert_eq!(listed.terminals.len(), 1);
    assert_eq!(client.terminal_get("duck").unwrap().address, address);

    let mut params = AttachParams::new(&address, 80, 24);
    params.history = 100;
    let (attachment, mut output) = client.attach(&params).unwrap();
    assert!(attachment.info().automatic_input);
    let first = read_until(&mut output, |_| true);
    assert_eq!(first.first(), Some(&0x18), "a repaint starts with CAN");

    attachment.focus(true).unwrap();
    attachment.input(b"echo duck$((40+2))\r").unwrap();
    read_until(&mut output, |seen| contains(seen, b"duck42"));
    attachment.resize(100, 30).unwrap();
    attachment.input(b"stty size\r").unwrap();
    read_until(&mut output, |seen| contains(seen, b"30 100"));

    let screen = client.terminal_read(&address, 50).unwrap();
    assert!(screen.text.contains("duck42"), "{}", screen.text);

    client
        .terminal_send(&SendParams {
            terminal: address.clone(),
            text: "echo sent-by-api".into(),
            force: true,
            ..SendParams::default()
        })
        .unwrap();
    read_until(&mut output, |seen| contains(seen, b"sent-by-api"));
    client.terminal_keys(&address, &["ctrl+u"]).unwrap();
    let interrupted = client.terminal_interrupt(&address, Some(1.0)).unwrap();
    assert!(!interrupted.outcome.is_empty());

    attachment.detach();
    loop {
        match output.recv() {
            Ok(StreamEvent::Closed(_)) | Err(_) => break,
            Ok(_) => {}
        }
    }

    assert_eq!(
        client.terminal_rm(&address).unwrap_err().kind(),
        Some("live")
    );
    client.terminal_kill(&address).unwrap();
    wait_for_event(&mut events, &address, EventKind::Finished);
    assert_eq!(client.terminal_rm(&address).unwrap().removed, address);
    wait_for_event(&mut events, &address, EventKind::Removed);
    assert_eq!(
        client.terminal_get(&address).unwrap_err().kind(),
        Some("not_found")
    );
}

#[test]
#[ignore = "starts a scratch herdr-core"]
fn machines_and_templates() {
    let core = ScratchCore::start("m").unwrap();
    let client = core.client().unwrap();
    assert!(client.machine_list().unwrap().is_empty());
    let _ = client.templates_list().unwrap();
    assert_eq!(
        client.machine_connect("nowhere").unwrap_err().kind(),
        Some("machine_unknown")
    );
    assert_eq!(
        client.machine_rm("nowhere").unwrap_err().kind(),
        Some("machine_unknown")
    );
    assert_eq!(
        client.machine_rename("nowhere", "else").unwrap_err().kind(),
        Some("machine_unknown")
    );
    let host = HcHost::new(client, Some("nowhere".into()));
    assert!(matches!(
        host.exec(ExecRequest::new(["true"])),
        Err(HostError::Unreachable(..))
    ));
}

#[test]
#[ignore = "starts a scratch herdr-core"]
fn another_scratch_core_is_a_machine_through_its_via_command() {
    // Dropped after `home`: a home core still dialling it would start it again.
    let other = ScratchCore::start("vo").unwrap();
    let home = ScratchCore::start("vh").unwrap();
    let client = home.client().unwrap();
    let added = client
        .machine_add(&ducky_hc::MachineAdd {
            name: Some("box".into()),
            via: Some(other.via_command().unwrap()),
            session: Some(other.session().into()),
            ..ducky_hc::MachineAdd::default()
        })
        .unwrap();
    assert!(added.via);
    let deadline = Instant::now() + Duration::from_secs(20);
    while client.machine_list().unwrap()[0].state.as_deref() != Some("connected") {
        assert!(Instant::now() < deadline, "the machine never connected");
        std::thread::sleep(Duration::from_millis(50));
    }
    let host = HcHost::new(client.clone(), Some("box".into()));
    let out = host
        .exec(ExecRequest::new(["sh", "-c", "echo $HC_SESSION"]))
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), other.session());
    client.machine_rm("box").unwrap();
}

#[test]
#[ignore = "starts a scratch herdr-core"]
fn git_through_the_core() {
    let core = ScratchCore::start("g").unwrap();
    let repo_dir = core.root().join("repo");
    std::fs::create_dir_all(&repo_dir).unwrap();
    let git = |args: &[&str]| {
        let status = Command::new("git")
            .args([
                "-c",
                "user.name=T",
                "-c",
                "user.email=t@x",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(&repo_dir)
            .output()
            .unwrap();
        assert!(status.status.success(), "{status:?}");
    };
    git(&["init", "-q", "-b", "main"]);
    std::fs::write(repo_dir.join("a file.txt"), "one\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "base"]);
    std::fs::write(repo_dir.join("a file.txt"), "one\ntwo\n").unwrap();
    std::fs::write(repo_dir.join("new.bin"), [0u8, 1, 2]).unwrap();

    let host = std::sync::Arc::new(HcHost::new(core.client().unwrap(), None));
    let repo = ducky_git::Repo::open(host, repo_dir.to_str().unwrap()).unwrap();
    assert_eq!(repo.head().unwrap().branch.as_deref(), Some("main"));
    let changes = repo.working_changes("HEAD").unwrap();
    let paths: Vec<&str> = changes.iter().map(|c| c.path.as_str()).collect();
    assert_eq!(paths, ["a file.txt", "new.bin"]);
    let spec = ducky_git::DiffSpec::WorkingTree {
        base: "HEAD".into(),
    };
    let patches = repo.patches(&spec, &changes).unwrap();
    let text = patches[0].diff.as_ref().unwrap();
    assert_eq!(text.hunks[0].lines.last().unwrap().text, "two");
    assert!(patches[1].diff.as_ref().unwrap().binary);
    assert_eq!(repo.read_worktree("new.bin").unwrap().unwrap(), [0, 1, 2]);
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn read_until(output: &mut ducky_hc::AttachOutput, done: impl Fn(&[u8]) -> bool) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut seen = Vec::new();
    while Instant::now() < deadline {
        if let Some(StreamEvent::Output(bytes)) =
            output.recv_timeout(Duration::from_millis(200)).unwrap()
        {
            seen.extend_from_slice(&bytes);
            if done(&seen) {
                return seen;
            }
        }
    }
    panic!("timed out; saw {:?}", String::from_utf8_lossy(&seen));
}

fn wait_for_event(events: &mut ducky_hc::Subscription, address: &str, kind: EventKind) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Some(EventMessage::Event(event)) =
            events.recv_timeout(Duration::from_millis(200)).unwrap()
            && event.terminal.as_deref() == Some(address)
            && event.kind == kind
        {
            return;
        }
    }
    panic!("no {kind:?} event for {address}");
}
