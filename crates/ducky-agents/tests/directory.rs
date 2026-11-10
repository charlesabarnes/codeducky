//! `AgentDirectory` against a scratch herdr-core. Opt in: `-- --ignored`.

mod support;

use ducky_agents::{
    AgentDirectory, AgentKind, AgentStatus, Connection, DirectoryEvent, DirectoryScope,
};
use ducky_hc::scratch::ScratchCore;
use ducky_hc::{Client, RunParams, SendParams};
use support::{eventually, fake_agent, path_str, receive};

fn run(client: &Client, argv: Vec<String>, cwd: &str, name: &str) -> String {
    client
        .terminal_run(&RunParams {
            argv,
            cwd: Some(cwd.into()),
            name: Some(name.into()),
            env: [("PS1".into(), "$ ".into())].into(),
            no_parent: true,
            ..RunParams::default()
        })
        .unwrap()
        .address
}

fn type_line(client: &Client, terminal: &str, text: &str) {
    client
        .terminal_send(&SendParams {
            terminal: terminal.into(),
            text: text.into(),
            force: true,
            ..SendParams::default()
        })
        .unwrap();
}

#[test]
#[ignore = "starts a scratch herdr-core"]
fn follows_the_repos_terminals() {
    let core = ScratchCore::start("dd").unwrap();
    let client = core.client().unwrap();
    let repo = core.root().join("repo");
    let outside = core.root().join("elsewhere");
    std::fs::create_dir_all(repo.join("sub")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    let (directory, events) =
        AgentDirectory::start(client.clone(), DirectoryScope::new(None, path_str(&repo))).unwrap();
    assert!(directory.agents().is_empty());

    let agent = run(&client, fake_agent(), &path_str(&repo), "fake");
    let shell = run(
        &client,
        vec!["/bin/sh".into()],
        &path_str(&outside),
        "outside",
    );
    receive(&events, "the agent appears", |event| {
        matches!(event, DirectoryEvent::Changed { address: Some(a) } if *a == agent).then_some(())
    });
    eventually("the agent's idle report", || {
        directory
            .agent(&agent)
            .filter(|a| a.status == AgentStatus::Idle)
    });
    let listed = directory.agents();
    assert_eq!(listed.len(), 1, "{listed:#?}");
    assert_eq!(listed[0].kind, AgentKind::Other("fake-agent".into()));
    assert_eq!(listed[0].name.as_deref(), Some("fake"));

    type_line(&client, &agent, "hello");
    let turn = receive(&events, "the turn to end", |event| match event {
        DirectoryEvent::TurnEnded { address, turn } if *address == agent => Some(*turn),
        _ => None,
    });
    assert_eq!(turn, 1);
    assert_eq!(directory.agent(&agent).unwrap().status, AgentStatus::Done);

    type_line(&client, &shell, &format!("cd {}/sub", path_str(&repo)));
    eventually("the shell to move into the repo", || {
        directory.agents().into_iter().find(|a| a.address == shell)
    });

    client.terminal_kill(&agent).unwrap();
    eventually("the agent's exit", || {
        directory
            .agent(&agent)
            .filter(|a| matches!(a.status, AgentStatus::Exited { .. }))
    });
    client.terminal_rm(&agent).unwrap();
    eventually("the agent's removal", || {
        directory.agent(&agent).is_none().then_some(())
    });

    core.stop();
    let reason = receive(&events, "the disconnect", |event| match event {
        DirectoryEvent::Disconnected { reason } => Some(reason.clone()),
        _ => None,
    });
    assert_eq!(directory.connection(), Connection::Disconnected(reason));

    let next = ScratchCore::start("de").unwrap();
    directory.reconnect(next.client().unwrap()).unwrap();
    assert_eq!(directory.connection(), Connection::Connected);
    assert!(directory.agents().is_empty());
}
