mod support;

use std::sync::{Arc, Barrier};
use std::thread;
use std::time::Duration;

use ducky_hc::wire::{self, Kind};
use ducky_hc::{
    AttachParams, Client, Display, Error, EventMessage, ExecParams, HcHost, StreamEvent,
    SubscribeParams,
};
use ducky_host::{ExecRequest, Host, HostError};
use serde_json::json;
use support::{FakeCore, exec_result, terminal};

#[test]
fn calls_decode_results_and_errors_with_their_kind() {
    let core = FakeCore::start(|peer| {
        let status = peer.request();
        assert_eq!(status["method"], "server.status");
        peer.reply(
            &status["id"],
            json!({"core": {"id": "c1", "name": "fake"}, "version": "0.1.19", "pid": 7,
                "uptime_ms": 5, "holders": [], "live": 2, "finished": 1}),
        );
        let get = peer.request();
        assert_eq!(get["params"], json!({"terminal": "t9"}));
        peer.error(&get["id"], "not_found", "no terminal t9");
    });
    let client = Client::connect(&core.path).unwrap();
    assert_eq!(client.hello().core.name, "fake");
    assert!(client.hello().has_feature("automatic_input"));
    let status = client.server_status().unwrap();
    assert_eq!((status.pid, status.live), (7, 2));
    let error = client.terminal_get("t9").unwrap_err();
    assert_eq!(error.kind(), Some("not_found"));
    match error {
        Error::Rpc(rpc) => assert_eq!(rpc.hint, "try again"),
        other => panic!("{other:?}"),
    }
    core.finish();
}

#[test]
fn replies_out_of_order_reach_their_callers() {
    let core = FakeCore::start(|peer| {
        let first = peer.request();
        let second = peer.request();
        peer.reply(
            &second["id"],
            json!({"removed": second["params"]["terminal"]}),
        );
        peer.reply(
            &first["id"],
            json!({"removed": first["params"]["terminal"]}),
        );
    });
    let client = Client::connect(&core.path).unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = ["t1", "t2"]
        .into_iter()
        .enumerate()
        .map(|(index, name)| {
            let (client, barrier) = (client.clone(), barrier.clone());
            thread::spawn(move || {
                if index == 1 {
                    barrier.wait();
                    thread::sleep(Duration::from_millis(50));
                } else {
                    barrier.wait();
                }
                client.terminal_rm(name).unwrap().removed
            })
        })
        .collect();
    let removed: Vec<String> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(removed, ["t1", "t2"]);
    core.finish();
}

#[test]
fn a_dropped_line_fails_pending_and_later_calls() {
    let core = FakeCore::start(|peer| {
        let _ = peer.request();
    });
    let client = Client::connect(&core.path).unwrap();
    assert!(matches!(
        client.machine_list().unwrap_err(),
        Error::Disconnected
    ));
    core.finish();
    assert!(!client.is_connected());
    assert!(matches!(
        client.templates_list().unwrap_err(),
        Error::Disconnected
    ));
}

#[test]
fn a_missing_socket_is_not_running() {
    let error = Client::connect("/tmp/no-such-dir-ducky/x.sock")
        .err()
        .unwrap();
    assert!(matches!(error, Error::NotRunning(_)));
}

#[test]
fn a_timed_out_call_is_cancelled_on_the_core() {
    let core = FakeCore::start(|peer| {
        let exec = peer.request();
        assert_eq!(exec["method"], "machine.exec");
        let cancel = peer.request();
        assert_eq!(cancel["method"], "$/cancelRequest");
        assert_eq!(cancel["params"]["id"], exec["id"]);
        peer.reply(&exec["id"], exec_result(b"late", 0));
        let list = peer.request();
        peer.reply(&list["id"], json!({"machines": []}));
    });
    let client = Client::connect(&core.path).unwrap();
    let params = ExecParams {
        argv: vec!["sleep".into(), "9".into()],
        ..ExecParams::default()
    };
    let error = client
        .exec_within(&params, Some(Duration::from_millis(100)))
        .unwrap_err();
    assert!(matches!(error, Error::Timeout));
    assert!(client.machine_list().unwrap().is_empty());
    core.finish();
}

fn event_line(seq: u64, kind: &str, terminal: &str) -> String {
    format!(
        "{}\n",
        json!({"jsonrpc": "2.0", "method": "event",
            "params": {"seq": seq, "type": kind, "terminal": terminal, "data": {}}})
    )
}

#[test]
fn events_arrive_in_order_across_split_frames_and_are_credited() {
    let core = FakeCore::start(|peer| {
        let subscribe = peer.request();
        assert_eq!(subscribe["params"], json!({"labels": {"repo": "x"}}));
        // Not paused on the core: an event may beat the reply.
        let early = event_line(6, "created", "t1");
        peer.send(3, Kind::Data, early.as_bytes());
        peer.reply(
            &subscribe["id"],
            json!({"seq": 5, "terminals": [terminal("t0")], "channel": 3}),
        );
        let lines = [
            event_line(6, "status", "t1"),
            event_line(7, "title", "t1"),
            format!(
                "{}\n",
                json!({"jsonrpc": "2.0", "method": "heartbeat", "params": {"seq": 7}})
            ),
            format!(
                "{}\n",
                json!({"jsonrpc": "2.0", "method": "missed",
                "params": {"seq": 20, "terminals": [terminal("t1")]}})
            ),
            event_line(19, "size", "t1"),
            event_line(21, "finished", "t1"),
        ]
        .concat();
        let (a, b) = lines.as_bytes().split_at(lines.len() / 2 + 3);
        peer.send(3, Kind::Data, a);
        peer.send(3, Kind::Data, b);
        let mut credited = 0;
        while credited < early.len() + lines.len() {
            let frame = peer.frame().unwrap();
            assert_eq!((frame.channel, frame.kind), (3, Kind::Credit as u8));
            credited += u32::from_le_bytes(frame.payload[..4].try_into().unwrap()) as usize;
        }
        assert_eq!(credited, early.len() + lines.len());
        peer.send(3, Kind::Close, br#"{"reason":"bye"}"#);
    });
    let client = Client::connect(&core.path).unwrap();
    let mut sub = client
        .subscribe(&SubscribeParams {
            labels: [("repo".into(), "x".into())].into(),
            ..SubscribeParams::default()
        })
        .unwrap();
    assert_eq!(sub.snapshot().seq, 5);
    assert_eq!(sub.snapshot().terminals[0].address, "t0");

    let mut seen = Vec::new();
    loop {
        match sub.recv().unwrap() {
            EventMessage::Event(event) => seen.push(format!("{}:{:?}", event.seq, event.kind)),
            EventMessage::Heartbeat { seq } => seen.push(format!("heartbeat {seq}")),
            EventMessage::Missed(snapshot) => seen.push(format!("missed {}", snapshot.seq)),
            EventMessage::Closed(reason) => {
                assert_eq!(reason.unwrap()["reason"], "bye");
                break;
            }
        }
    }
    assert_eq!(
        seen,
        [
            "6:Created",
            "7:Title",
            "heartbeat 7",
            "missed 20",
            "21:Finished"
        ]
    );
    assert!(matches!(sub.recv(), Err(Error::Disconnected)));
    core.finish();
}

#[test]
fn dropping_a_subscription_unsubscribes() {
    let core = FakeCore::start(|peer| {
        let subscribe = peer.request();
        peer.reply(
            &subscribe["id"],
            json!({"seq": 0, "terminals": [], "channel": 4}),
        );
        let close = peer.next_non_credit();
        assert_eq!((close.channel, close.kind), (4, Kind::Close as u8));
        assert!(close.payload.is_empty());
    });
    let client = Client::connect(&core.path).unwrap();
    let mut sub = client.subscribe(&SubscribeParams::default()).unwrap();
    assert!(
        sub.recv_timeout(Duration::from_millis(20))
            .unwrap()
            .is_none()
    );
    drop(sub);
    core.finish();
}

#[test]
fn attach_streams_output_with_credit_and_sends_viewer_frames() {
    let core = FakeCore::start(|peer| {
        let attach = peer.request();
        assert_eq!(attach["method"], "terminal.attach");
        assert_eq!(attach["params"]["terminal"], "t2");
        assert_eq!(attach["params"]["history"], 1000);
        assert_eq!(attach["params"]["display"], json!({"fg": "#ffffff"}));
        peer.reply(
            &attach["id"],
            json!({"channel": 2, "terminal": terminal("t2"),
                "resize_notifications": false, "automatic_input": true}),
        );
        peer.send(2, Kind::Data, b"\x18repaint");
        peer.send(2, Kind::Resize, &wire::size_payload(100, 30));
        let credit = peer.frame().unwrap();
        assert_eq!((credit.channel, credit.kind), (2, Kind::Credit as u8));
        assert_eq!(credit.payload, 8u32.to_le_bytes());

        let expect = [
            (Kind::Data, b"ls\r".to_vec()),
            (Kind::AutomaticInput, b"\x1b[0n".to_vec()),
            (Kind::Resize, wire::size_payload(120, 40).to_vec()),
            (Kind::Focus, vec![1]),
            (Kind::Facts, br#"{"cell":[9,18]}"#.to_vec()),
            (Kind::Close, vec![]),
        ];
        for (kind, payload) in expect {
            let frame = peer.next_non_credit();
            assert_eq!((frame.channel, frame.kind), (2, kind as u8));
            assert_eq!(frame.payload, payload);
        }
        peer.send(2, Kind::Close, b"");
    });
    let client = Client::connect(&core.path).unwrap();
    let mut params = AttachParams::new("t2", 80, 24);
    params.history = 1000;
    params.display = Some(Display {
        fg: Some("#ffffff".into()),
        ..Display::default()
    });
    let (attachment, mut output) = client.attach(&params).unwrap();
    assert_eq!(attachment.channel(), 2);
    assert_eq!(
        output.recv().unwrap(),
        StreamEvent::Output(b"\x18repaint".to_vec())
    );
    assert_eq!(
        output.recv().unwrap(),
        StreamEvent::Resized {
            cols: 100,
            rows: 30
        }
    );
    attachment.input(b"ls\r").unwrap();
    attachment.automatic_input(b"\x1b[0n").unwrap();
    attachment.resize(120, 40).unwrap();
    attachment.focus(true).unwrap();
    attachment
        .facts(&Display {
            cell: Some([9, 18]),
            ..Display::default()
        })
        .unwrap();
    attachment.detach();
    assert!(matches!(attachment.input(b"x"), Err(Error::Disconnected)));
    assert_eq!(output.recv().unwrap(), StreamEvent::Closed(None));
    assert!(matches!(output.recv(), Err(Error::Disconnected)));
    core.finish();
}

#[test]
fn hc_host_maps_exec_and_errors() {
    let core = FakeCore::start(|peer| {
        let exec = peer.request();
        let params = &exec["params"];
        assert_eq!(params["argv"], json!(["git", "status"]));
        assert_eq!(params["on"], "box");
        assert_eq!(params["cwd"], "/repo");
        assert_eq!(params["env"], json!({"LC_ALL": "C"}));
        assert_eq!(params["timeout"], 600.0);
        assert_eq!(params["input"], "aGk=");
        peer.reply(&exec["id"], exec_result(b"ok", 3));
        let missing = peer.request();
        peer.error(
            &missing["id"],
            "spawn_failed",
            "cannot start nope: No such file or directory (os error 2)",
        );
        let unknown = peer.request();
        peer.error(&unknown["id"], "machine_unknown", "no machine box");
    });
    let host = HcHost::new(Client::connect(&core.path).unwrap(), Some("box".into()));
    assert_eq!(host.name(), "box");
    let mut request = ExecRequest::new(["git", "status"])
        .cwd("/repo")
        .stdin("hi")
        .timeout(Duration::from_secs(9999));
    request.env.push(("LC_ALL".into(), "C".into()));
    let output = host.exec(request).unwrap();
    assert_eq!(
        (output.status, output.stdout.as_slice()),
        (Some(3), &b"ok"[..])
    );
    assert!(matches!(
        host.exec(ExecRequest::new(["nope"])),
        Err(HostError::NotFound(p)) if p == "nope"
    ));
    assert!(matches!(
        host.exec(ExecRequest::new(["true"])),
        Err(HostError::Unreachable(..))
    ));
    core.finish();
}

#[test]
fn hc_host_reads_text_in_pages_and_bytes_through_dd() {
    let core = FakeCore::start(|peer| {
        let first = peer.request();
        assert_eq!(first["params"]["offset"], 1);
        peer.reply(
            &first["id"],
            json!({"text": "a\r\n", "first": 1, "last": 1, "lines": 2}),
        );
        let second = peer.request();
        assert_eq!(second["params"]["offset"], 2);
        peer.reply(
            &second["id"],
            json!({"text": "é", "first": 2, "last": 2, "lines": 2}),
        );

        let binary = peer.request();
        peer.error(&binary["id"], "not_text", "not UTF-8");
        let dd = peer.request();
        assert_eq!(dd["method"], "machine.exec");
        assert_eq!(dd["params"]["argv"][0], "dd");
        assert_eq!(dd["params"]["argv"][1], "if=/b.bin");
        assert_eq!(dd["params"]["argv"][3], "skip=0");
        peer.reply(&dd["id"], exec_result(&[0, 159, 146, 150], 0));

        let missing = peer.request();
        peer.error(&missing["id"], "not_found", "no file");

        let write = peer.request();
        assert_eq!(write["method"], "file.write");
        assert_eq!(write["params"], json!({"path": "/w", "data": "AAE="}));
        peer.reply(&write["id"], json!({"path": "/w", "bytes": 2}));
    });
    let host = HcHost::new(Client::connect(&core.path).unwrap(), None);
    assert_eq!(host.name(), "fake");
    assert_eq!(host.read_file("/t.txt").unwrap(), "a\r\né".as_bytes());
    assert_eq!(host.read_file("/b.bin").unwrap(), [0, 159, 146, 150]);
    assert!(matches!(
        host.read_file("/gone"),
        Err(HostError::NotFound(_))
    ));
    host.write_file("/w", &[0, 1]).unwrap();
    core.finish();
}

#[test]
fn unknown_frame_kinds_and_stray_channels_are_ignored() {
    let core = FakeCore::start(|peer| {
        peer.send(9, Kind::Data, b"nobody listens");
        let mut odd = wire::encode(0, Kind::Data, b"");
        odd[4] = 77;
        peer.raw(&odd);
        peer.send(0, Kind::Close, b"");
        let list = peer.request();
        peer.reply(
            &list["id"],
            json!({"machines": [{"name": "m", "target": "m",
            "id": "i", "host": "h", "version": "v", "state": "connected"}]}),
        );
    });
    let client = Client::connect(&core.path).unwrap();
    let machines = client.machine_list().unwrap();
    assert_eq!(machines[0].state.as_deref(), Some("connected"));
    core.finish();
}
