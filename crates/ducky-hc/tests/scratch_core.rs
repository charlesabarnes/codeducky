//! Against a real herdr-core that each test starts for itself and stops again: its own
//! `HC_SESSION`, scratch `XDG_*` dirs, and none of the calling terminal's `HC_*` variables, so the
//! user's live core is never involved. Opt in: `cargo test -p ducky-hc -- --ignored`
//! (`HC_BIN` picks the binary; default `hc` on PATH, then `~/.local/bin/hc`).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use ducky_hc::{
    AttachParams, Client, EventKind, EventMessage, HcHost, RunParams, SendParams, Size,
    StreamEvent, SubscribeParams,
};
use ducky_host::{ExecRequest, Host, HostError};

struct ScratchCore {
    dir: tempfile::TempDir,
    session: String,
    socket: PathBuf,
}

fn hc_bin() -> PathBuf {
    if let Ok(bin) = std::env::var("HC_BIN") {
        return bin.into();
    }
    let on_path = Command::new("hc").arg("--version").output();
    if on_path.is_ok_and(|o| o.status.success()) {
        return "hc".into();
    }
    Path::new(&std::env::var("HOME").unwrap()).join(".local/bin/hc")
}

impl ScratchCore {
    fn start(tag: &str) -> Self {
        let dir = tempfile::Builder::new()
            .prefix("dk")
            .tempdir_in("/tmp")
            .unwrap();
        let session = format!("dk{tag}{}", std::process::id() % 10_000);
        let socket = dir
            .path()
            .join("run/herdr-core")
            .join(format!("{session}.sock"));
        let core = Self {
            dir,
            session,
            socket,
        };
        let status = core.hc(&["server", "status"]);
        assert!(status.status.success(), "{status:?}");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !core.socket.exists() {
            assert!(Instant::now() < deadline, "no socket at {:?}", core.socket);
            std::thread::sleep(Duration::from_millis(50));
        }
        core
    }

    fn hc(&self, args: &[&str]) -> std::process::Output {
        let root = self.dir.path();
        Command::new(hc_bin())
            .args(args)
            .env_remove("HC_TERMINAL_ID")
            .env_remove("HC_TERMINAL_SOCKET")
            .env_remove("HC_SCOPE")
            .env_remove("HC_SOCKET")
            .env("HC_SESSION", &self.session)
            .env("XDG_STATE_HOME", root.join("state"))
            .env("XDG_CONFIG_HOME", root.join("config"))
            .env("XDG_RUNTIME_DIR", root.join("run"))
            .env("SSH_CONNECTION", "127.0.0.1 0 127.0.0.1 0")
            .output()
            .unwrap()
    }

    fn client(&self) -> Client {
        assert!(self.socket.starts_with(self.dir.path()));
        Client::connect(&self.socket).unwrap()
    }
}

impl Drop for ScratchCore {
    fn drop(&mut self) {
        let _ = self.hc(&["server", "stop"]);
    }
}

#[test]
#[ignore = "starts a scratch herdr-core"]
fn exec_and_byte_exact_files() {
    let core = ScratchCore::start("f");
    let client = core.client();
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

    let root = core.dir.path().join("files");
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
    let core = ScratchCore::start("t");
    let client = core.client();
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
    let core = ScratchCore::start("m");
    let client = core.client();
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
