//! `HcTerminalSource` against a scratch herdr-core. Opt in: `-- --ignored`.

mod support;

use std::process::Command;

use ducky_agents::HcTerminalSource;
use ducky_hc::scratch::ScratchCore;
use ducky_hc::{AttachParams, Client, RunParams, Size};
use ducky_terminal::Rgb;
use ducky_terminal::source::{
    AttachRequest, CloseReason, DisplayFacts, GridSize, SourceEvent, TerminalSource, ViewerMessage,
};
use support::receive;

fn grid(cols: u16, rows: u16) -> GridSize {
    GridSize {
        cols,
        rows,
        cell_width: 8,
        cell_height: 16,
    }
}

fn request(cols: u16, rows: u16) -> AttachRequest {
    AttachRequest {
        size: grid(cols, rows),
        history: 200,
        display: DisplayFacts {
            foreground: Rgb {
                r: 0xee,
                g: 0xee,
                b: 0xee,
            },
            background: Rgb {
                r: 0x10,
                g: 0x10,
                b: 0x10,
            },
            cursor: Rgb {
                r: 0xff,
                g: 0,
                b: 0,
            },
            cell_width: 8,
            cell_height: 16,
        },
    }
}

fn shell(client: &Client, keep: bool) -> String {
    client
        .terminal_run(&RunParams {
            argv: vec!["/bin/sh".into()],
            env: [("PS1".into(), "$ ".into())].into(),
            size: Some(Size { cols: 80, rows: 24 }),
            no_parent: true,
            keep,
            ..RunParams::default()
        })
        .unwrap()
        .address
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack
        .windows(needle.len())
        .any(|w| w == needle.as_bytes())
}

/// Collects output until it contains `needle`; other events are an error.
fn output_until(rx: &flume::Receiver<SourceEvent>, needle: &str) -> Vec<u8> {
    let mut seen = Vec::new();
    receive(rx, needle, |event| match event {
        SourceEvent::Output(bytes) => {
            seen.extend_from_slice(bytes);
            contains(&seen, needle).then(|| seen.clone())
        }
        SourceEvent::SizeChanged { .. } => None,
        other => panic!("unexpected {other:?}"),
    })
}

#[test]
#[ignore = "starts a scratch herdr-core"]
fn typing_resizing_and_exit() {
    let core = ScratchCore::start("as").unwrap();
    let client = core.client().unwrap();
    let address = shell(&client, false);
    let mut source = HcTerminalSource::new(client.clone(), address.clone());

    let rx = source.attach(&request(80, 24)).unwrap();
    let first = output_until(&rx, "$ ");
    assert_eq!(first.first(), Some(&0x18), "a repaint starts with CAN");

    source.send(ViewerMessage::Focus {
        focused: true,
        report: None,
    });
    source.send(ViewerMessage::Input(b"echo duck$((40+2))\r".to_vec()));
    output_until(&rx, "duck42");

    source.send(ViewerMessage::Resize(GridSize {
        cell_width: 9,
        ..grid(100, 30)
    }));
    source.send(ViewerMessage::Input(b"stty size\r".to_vec()));
    output_until(&rx, "30 100");
    assert_eq!(
        (
            client.terminal_get(&address).unwrap().cols,
            client.terminal_get(&address).unwrap().rows
        ),
        (100, 30)
    );

    source.send(ViewerMessage::Input(b"exit 3\r".to_vec()));
    let closed = receive(&rx, "exit", |event| match event {
        SourceEvent::Closed(reason) => Some(reason.clone()),
        _ => None,
    });
    assert_eq!(closed, CloseReason::Exited { code: Some(3) });
}

#[test]
#[ignore = "starts a scratch herdr-core"]
fn another_viewer_taking_the_size_is_reported() {
    let core = ScratchCore::start("av").unwrap();
    let client = core.client().unwrap();
    let address = shell(&client, false);
    let mut source = HcTerminalSource::new(client.clone(), address.clone());
    let rx = source.attach(&request(80, 24)).unwrap();
    output_until(&rx, "$ ");
    source.send(ViewerMessage::Resize(grid(90, 25)));

    let other = core.client().unwrap();
    let (theirs, _output) = other.attach(&AttachParams::new(&address, 120, 40)).unwrap();
    theirs.resize(120, 40).unwrap();
    let mut sizes = Vec::new();
    receive(&rx, "the other viewer's size", |event| match event {
        SourceEvent::SizeChanged { cols, rows } => {
            sizes.push((*cols, *rows));
            (sizes.last() == Some(&(120, 40))).then_some(())
        }
        _ => None,
    });
    assert!(
        !sizes.contains(&(80, 24)),
        "the echo of our first size came after we resized: {sizes:?}"
    );

    source.send(ViewerMessage::Resize(grid(80, 24)));
    receive(&rx, "our size back", |event| {
        matches!(event, SourceEvent::SizeChanged { cols: 80, rows: 24 }).then_some(())
    });
}

#[test]
#[ignore = "starts a scratch herdr-core"]
fn reattaching_replays_history_at_the_new_width() {
    let core = ScratchCore::start("ar").unwrap();
    let client = core.client().unwrap();
    let address = shell(&client, false);
    let mut source = HcTerminalSource::new(client, address);
    let first = source.attach(&request(80, 24)).unwrap();
    output_until(&first, "$ ");
    source.send(ViewerMessage::Input(
        b"printf 'wide-%060d\\n' 1 2 3; seq 100 140\r".to_vec(),
    ));
    output_until(&first, "140\r\n");

    let second = source.attach(&request(40, 24)).unwrap();
    let replay = output_until(&second, "140");
    assert_eq!(replay.first(), Some(&0x18));
    assert!(contains(&replay, "printf 'wide-"), "history comes along");
    assert!(
        !contains(&replay, &format!("wide-{:060}", 1)),
        "rewrapped at 40 columns"
    );
    while let Ok(event) = first.try_recv() {
        assert!(
            !matches!(event, SourceEvent::Closed(_)),
            "the old stream ends quietly"
        );
    }
}

#[test]
#[ignore = "starts a scratch herdr-core"]
fn a_kept_terminal_that_loses_its_program_asks_for_a_reattach() {
    let core = ScratchCore::start("ak").unwrap();
    let client = core.client().unwrap();
    let address = shell(&client, true);
    let mut source = HcTerminalSource::new(client.clone(), address.clone());
    let rx = source.attach(&request(80, 24)).unwrap();
    output_until(&rx, "$ ");

    let pid = client.terminal_get(&address).unwrap().pid.unwrap();
    let killed = Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .unwrap();
    assert!(killed.success());
    receive(
        &rx,
        "a reattach request after restart",
        |event| match event {
            SourceEvent::ReattachRequested => Some(()),
            SourceEvent::Closed(reason) => panic!("closed instead: {reason:?}"),
            _ => None,
        },
    );
    let again = source.attach(&request(80, 24)).unwrap();
    // Not `\e[?2004h`: whether /bin/sh turns on bracketed paste depends on which shell it is
    // (Debian and Ubuntu's dash never does). A command's echo proves a live program on any.
    source.send(ViewerMessage::Input(b"echo again$((1+1))\r".to_vec()));
    output_until(&again, "again2");
}
