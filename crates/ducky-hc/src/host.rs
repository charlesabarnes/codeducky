use std::time::Duration;

use ducky_host::{ExecOutput, ExecRequest, Host, HostError};

use crate::api::{MAX_EXEC_STDIN, MAX_EXEC_TIMEOUT, MAX_FILE_IO};
use crate::client::Client;
use crate::error::Error;
use crate::types::{ExecParams, FileRead};

/// Bytes per `dd` read when a file comes through exec; fits the 8 MiB stdout cap exactly.
const EXEC_CHUNK: usize = 8 << 20;
const DD_BLOCK: usize = 1 << 20;
/// How long past the exec's own timeout to wait for its reply before giving up on the core.
const REPLY_GRACE: Duration = Duration::from_secs(30);

/// One machine through herdr-core: `None` is the core's own machine, `Some(name)` another one
/// (`on: name`), reached through the core.
///
/// Limits, from herdr-core 0.1.19:
/// - `exec`: stdout keeps the first 8 MiB and stderr the first 1 MiB (then `truncated`, which
///   does not say which); stdin at most 8 MiB; timeout 60 s by default, clamped to 600 s; at most
///   16 execs run on a core at once (the 17th is `unavailable`). The core runs programs with its
///   own environment plus `request.env`, not this process's.
/// - `read_file` is byte-exact. UTF-8 text goes through `file.read`, page by page; anything
///   else (not UTF-8, or over the core's 64 MiB text limit) through `dd` over exec in 8 MiB
///   chunks. There is no size cap beyond memory: check sizes first for files that may be huge.
/// - `write_file` is byte-exact. Up to 8 MiB goes through `file.write`: atomic, through
///   symlinks, keeping the file's mode. Larger data is streamed over exec into `<path>.ducky-tmp`
///   in 8 MiB chunks and renamed over the file at the end, which needs `sh` and replaces a
///   symlink instead of following it.
#[derive(Clone)]
pub struct HcHost {
    client: Client,
    machine: Option<String>,
    name: String,
}

impl HcHost {
    pub fn new(client: Client, machine: Option<String>) -> Self {
        let name = machine
            .clone()
            .unwrap_or_else(|| client.hello().core.name.clone());
        Self {
            client,
            machine,
            name,
        }
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    pub fn machine(&self) -> Option<&str> {
        self.machine.as_deref()
    }

    fn fail(&self, error: Error) -> HostError {
        match error {
            Error::Rpc(rpc) if rpc.is("machine_unknown") || rpc.is("unavailable") => {
                HostError::Unreachable(self.name.clone(), rpc.message)
            }
            Error::Rpc(rpc) => HostError::Other(format!("{}: {}", self.name, rpc)),
            Error::Protocol(message) => HostError::Other(message),
            other => HostError::Unreachable(self.name.clone(), other.to_string()),
        }
    }

    fn run(&self, params: ExecParams) -> Result<ExecOutput, HostError> {
        let program = params.argv.first().cloned().unwrap_or_default();
        let limit = Duration::from_secs_f64(params.timeout.unwrap_or(60.0)) + REPLY_GRACE;
        let result =
            self.client
                .exec_within(&params, Some(limit))
                .map_err(|error| match error {
                    Error::Rpc(rpc) if rpc.is("spawn_failed") && missing_program(&rpc.message) => {
                        HostError::NotFound(program)
                    }
                    other => self.fail(other),
                })?;
        Ok(ExecOutput {
            status: if result.signal.is_some() {
                None
            } else {
                result.code
            },
            stdout: result.stdout,
            stderr: result.stderr,
            truncated: result.truncated,
            timed_out: result.timed_out,
        })
    }

    fn read_text(&self, path: &str) -> Result<Option<Vec<u8>>, HostError> {
        let mut bytes = Vec::new();
        let mut offset = 1;
        let mut total = None;
        loop {
            let page = self.client.file_read(&FileRead {
                path: path.into(),
                on: self.machine.clone(),
                offset: Some(offset),
                ..FileRead::default()
            });
            let page = match page {
                Ok(page) => page,
                Err(Error::Rpc(rpc)) if rpc.is("not_found") => {
                    return Err(HostError::NotFound(path.into()));
                }
                Err(Error::Rpc(rpc)) if rpc.is("not_text") || rpc.is("invalid_params") => {
                    return Ok(None);
                }
                Err(other) => return Err(self.fail(other)),
            };
            if *total.get_or_insert(page.lines) != page.lines {
                return Ok(None);
            }
            bytes.extend_from_slice(page.text.as_bytes());
            if page.last >= page.lines {
                return Ok(Some(bytes));
            }
            offset = page.last + 1;
        }
    }

    fn read_raw(&self, path: &str) -> Result<Vec<u8>, HostError> {
        let mut bytes = Vec::new();
        loop {
            let skip = bytes.len() / DD_BLOCK;
            let output = self.run(ExecParams {
                argv: vec![
                    "dd".into(),
                    format!("if={path}"),
                    format!("bs={DD_BLOCK}"),
                    format!("skip={skip}"),
                    format!("count={}", EXEC_CHUNK / DD_BLOCK),
                ],
                on: self.machine.clone(),
                timeout: Some(MAX_EXEC_TIMEOUT),
                ..ExecParams::default()
            })?;
            if !output.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(if missing_program(&stderr) {
                    HostError::NotFound(path.into())
                } else {
                    HostError::Other(format!("{path}: {}", stderr.trim()))
                });
            }
            let chunk = output.stdout.len();
            bytes.extend_from_slice(&output.stdout);
            if chunk < EXEC_CHUNK {
                return Ok(bytes);
            }
        }
    }

    fn write_large(&self, path: &str, data: &[u8]) -> Result<(), HostError> {
        let staged = format!("{path}.ducky-tmp");
        for (index, chunk) in data.chunks(MAX_EXEC_STDIN).enumerate() {
            let line = if index == 0 {
                r#"mkdir -p -- "$(dirname -- "$1")" && cat > "$2""#
            } else {
                r#"cat >> "$2""#
            };
            self.shell(line, path, &staged, Some(chunk.to_vec()))?;
        }
        self.shell(r#"mv -f -- "$2" "$1""#, path, &staged, None)
    }

    fn shell(
        &self,
        line: &str,
        path: &str,
        staged: &str,
        input: Option<Vec<u8>>,
    ) -> Result<(), HostError> {
        let output = self.run(ExecParams {
            argv: vec![
                "sh".into(),
                "-c".into(),
                line.into(),
                "sh".into(),
                path.into(),
                staged.into(),
            ],
            on: self.machine.clone(),
            input,
            timeout: Some(MAX_EXEC_TIMEOUT),
            ..ExecParams::default()
        })?;
        if output.success() {
            return Ok(());
        }
        let _ = self.run(ExecParams {
            argv: vec!["rm".into(), "-f".into(), "--".into(), staged.into()],
            on: self.machine.clone(),
            ..ExecParams::default()
        });
        Err(HostError::Other(format!(
            "{path}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

fn missing_program(message: &str) -> bool {
    message.contains("No such file") || message.contains("not found")
}

impl Host for HcHost {
    fn name(&self) -> &str {
        &self.name
    }

    fn exec(&self, request: ExecRequest) -> Result<ExecOutput, HostError> {
        if request.argv.is_empty() {
            return Err(HostError::Other("exec needs a program".into()));
        }
        self.run(ExecParams {
            argv: request.argv,
            cwd: request.cwd,
            env: request.env.into_iter().collect(),
            on: self.machine.clone(),
            input: request.stdin,
            timeout: request
                .timeout
                .map(|t| t.as_secs_f64().clamp(0.001, MAX_EXEC_TIMEOUT)),
            line: None,
        })
    }

    fn read_file(&self, path: &str) -> Result<Vec<u8>, HostError> {
        match self.read_text(path)? {
            Some(bytes) => Ok(bytes),
            None => self.read_raw(path),
        }
    }

    fn write_file(&self, path: &str, data: &[u8]) -> Result<(), HostError> {
        if data.len() > MAX_FILE_IO {
            return self.write_large(path, data);
        }
        self.client
            .file_write(path, self.machine.as_deref(), data)
            .map(|_| ())
            .map_err(|error| self.fail(error))
    }
}
