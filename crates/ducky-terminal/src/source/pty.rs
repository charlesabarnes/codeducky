//! A local PTY source for the demo and manual testing. The app itself attaches to hc terminals.
//!
//! The program starts on the first attach, at the measured size. A PTY cannot replay, so a later
//! attach only redirects further output to the new stream.

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};

use super::{
    AttachRequest, CloseReason, GridSize, SourceError, SourceEvent, TerminalSource, ViewerMessage,
};

/// Environment variable prefixes that belong to the agent or terminal that launched us; a shell
/// inheriting them would think it runs inside that agent or hc terminal.
const SCRUBBED_PREFIXES: &[&str] = &["CLAUDE", "HC_", "TERM_PROGRAM"];

#[derive(Clone, Debug, Default)]
pub struct PtyCommand {
    /// `None` runs the user's login shell.
    pub program: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<std::path::PathBuf>,
    pub env: Vec<(String, String)>,
}

pub struct LocalPtySource {
    command: PtyCommand,
    running: Option<Running>,
    stream: Arc<Mutex<Option<flume::Sender<SourceEvent>>>>,
}

struct Running {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

impl LocalPtySource {
    pub fn new(command: PtyCommand) -> Self {
        Self {
            command,
            running: None,
            stream: Arc::new(Mutex::new(None)),
        }
    }

    fn spawn(&mut self, size: GridSize) -> Result<(), SourceError> {
        let pair = native_pty_system()
            .openpty(pty_size(size))
            .map_err(|e| SourceError::Attach(e.to_string()))?;
        let mut cmd = match &self.command.program {
            Some(program) => CommandBuilder::new(program),
            None => CommandBuilder::new_default_prog(),
        };
        cmd.args(&self.command.args);
        for (key, _) in std::env::vars() {
            if SCRUBBED_PREFIXES.iter().any(|p| key.starts_with(p)) {
                cmd.env_remove(key);
            }
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "codeducky");
        for (key, value) in &self.command.env {
            cmd.env(key, value);
        }
        if let Some(cwd) = &self.command.cwd {
            cmd.cwd(cwd);
        }
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| SourceError::Attach(e.to_string()))?;
        drop(pair.slave);
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| SourceError::Attach(e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| SourceError::Attach(e.to_string()))?;
        spawn_reader(reader, child, self.stream.clone());
        self.running = Some(Running {
            master: pair.master,
            writer,
        });
        Ok(())
    }

    fn write(&mut self, bytes: &[u8]) {
        if let Some(running) = &mut self.running {
            let _ = running.writer.write_all(bytes);
        }
    }
}

impl TerminalSource for LocalPtySource {
    fn attach(
        &mut self,
        request: &AttachRequest,
    ) -> Result<flume::Receiver<SourceEvent>, SourceError> {
        let (tx, rx) = flume::unbounded();
        *self.stream.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
        match &self.running {
            None => self.spawn(request.size)?,
            Some(running) => {
                let _ = running.master.resize(pty_size(request.size));
            }
        }
        Ok(rx)
    }

    fn send(&mut self, message: ViewerMessage) {
        match message {
            ViewerMessage::Input(bytes) | ViewerMessage::AutomaticInput(bytes) => {
                self.write(&bytes)
            }
            ViewerMessage::Focus {
                report: Some(report),
                ..
            } => self.write(&report),
            ViewerMessage::Resize(size) => {
                if let Some(running) = &self.running {
                    let _ = running.master.resize(pty_size(size));
                }
            }
            ViewerMessage::Detach => {
                *self.stream.lock().unwrap_or_else(|e| e.into_inner()) = None;
            }
            ViewerMessage::Focus { report: None, .. } | ViewerMessage::Display(_) => {}
        }
    }
}

fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn Child + Send + Sync>,
    stream: Arc<Mutex<Option<flume::Sender<SourceEvent>>>>,
) {
    let (exit_tx, exit_rx) = flume::bounded(1);
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code() as i32);
        let _ = exit_tx.send(code);
    });
    std::thread::spawn(move || {
        let send = |event| {
            if let Some(tx) = stream.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                let _ = tx.send(event);
            }
        };
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => send(SourceEvent::Output(buf[..n].to_vec())),
            }
        }
        let code = exit_rx.recv_timeout(Duration::from_secs(2)).ok().flatten();
        send(SourceEvent::Closed(CloseReason::Exited { code }));
    });
}

fn pty_size(size: GridSize) -> PtySize {
    PtySize {
        rows: size.rows,
        cols: size.cols,
        pixel_width: (u32::from(size.cols) * size.cell_width).min(u32::from(u16::MAX)) as u16,
        pixel_height: (u32::from(size.rows) * size.cell_height).min(u32::from(u16::MAX)) as u16,
    }
}
