//! Scratch herdr-cores for dev runs (`--scratch`, `--scratch-machine`): started here, stopped and
//! their folders removed when the run ends, so a dev run never needs the live core.

use std::sync::Mutex;

use ducky_hc::scratch::ScratchCore;

static CORES: Mutex<Vec<ScratchCore>> = Mutex::new(Vec::new());

fn cores() -> std::sync::MutexGuard<'static, Vec<ScratchCore>> {
    CORES.lock().unwrap_or_else(|e| e.into_inner())
}

/// Starts a core and keeps it until [`stop_all`]; returns its socket, via command and session.
pub fn start(tag: &str) -> Result<(std::path::PathBuf, String, String), String> {
    let core = ScratchCore::start(tag).map_err(|e| format!("scratch core: {e}"))?;
    let socket = core.socket().to_owned();
    let via = core
        .via_command()
        .map_err(|e| format!("scratch core: {e}"))?;
    let session = core.session().to_owned();
    eprintln!(
        "scratch core {session} at {} (HC_SESSION={session} XDG_RUNTIME_DIR={root}/run \
         XDG_STATE_HOME={root}/state XDG_CONFIG_HOME={root}/config)",
        socket.display(),
        root = core.root().display()
    );
    cores().push(core);
    Ok((socket, via, session))
}

/// Stops every core this run started and removes its folder.
pub fn stop_all() {
    let stopped: Vec<ScratchCore> = cores().drain(..).collect();
    drop(stopped);
}

/// Writes a template into the first scratch core's config (`--scratch-template name=command`).
pub fn add_template(name: &str, command: &str) -> Result<(), String> {
    let cores = cores();
    let core = cores.first().ok_or("--scratch-template needs --scratch")?;
    let dir = core.config_dir().join("templates");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let text = format!(
        "---\nname: {name}\ndescription: A stand-in agent for dev runs\ncommand: {command}\n---\n\
         You review code.\n"
    );
    std::fs::write(dir.join(format!("{name}.md")), text).map_err(|e| e.to_string())
}

/// Stops the first scratch core but keeps its folder (`--stop-core`), to see a disconnect.
pub fn stop_first() {
    if let Some(core) = cores().first() {
        core.stop();
    }
}
