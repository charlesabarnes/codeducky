use std::io::{ErrorKind, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use crate::{ExecOutput, ExecRequest, Host, HostError};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);

/// This machine, without herdr-core. Used by tests and as a fallback.
#[derive(Debug, Clone, Copy, Default)]
pub struct LocalHost;

impl Host for LocalHost {
    fn name(&self) -> &str {
        "local"
    }

    fn exec(&self, request: ExecRequest) -> Result<ExecOutput, HostError> {
        let (program, args) = request
            .argv
            .split_first()
            .ok_or_else(|| HostError::Other("exec needs a program".into()))?;
        let mut command = Command::new(program);
        command
            .args(args)
            .envs(request.env.iter().map(|(k, v)| (k, v)))
            .stdin(if request.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = &request.cwd {
            command.current_dir(cwd);
        }
        let mut child = command.spawn().map_err(|error| match error.kind() {
            ErrorKind::NotFound => HostError::NotFound(program.clone()),
            _ => HostError::Other(format!("{program}: {error}")),
        })?;

        let stdin = child.stdin.take().zip(request.stdin);
        let writer = stdin.map(|(mut pipe, bytes)| {
            thread::spawn(move || {
                let _ = pipe.write_all(&bytes);
            })
        });
        let stdout = drain(child.stdout.take());
        let stderr = drain(child.stderr.take());

        let (done, finished) = mpsc::channel();
        let timeout = request.timeout.unwrap_or(DEFAULT_TIMEOUT);
        let id = child.id();
        let waiter = thread::spawn(move || {
            let status = child.wait();
            let _ = done.send(());
            status
        });
        let timed_out = finished.recv_timeout(timeout).is_err();
        if timed_out {
            let _ = Command::new("kill").arg("-9").arg(id.to_string()).status();
        }
        let status = waiter
            .join()
            .map_err(|_| HostError::Other("wait thread panicked".into()))?
            .map_err(|error| HostError::Other(error.to_string()))?;
        if let Some(writer) = writer {
            let _ = writer.join();
        }

        Ok(ExecOutput {
            status: if timed_out { None } else { status.code() },
            stdout: stdout.join().unwrap_or_default(),
            stderr: stderr.join().unwrap_or_default(),
            truncated: false,
            timed_out,
        })
    }

    fn read_file(&self, path: &str) -> Result<Vec<u8>, HostError> {
        std::fs::read(path).map_err(|error| match error.kind() {
            ErrorKind::NotFound => HostError::NotFound(path.into()),
            _ => HostError::Other(format!("{path}: {error}")),
        })
    }

    fn write_file(&self, path: &str, data: &[u8]) -> Result<(), HostError> {
        let fail = |error: std::io::Error| HostError::Other(format!("{path}: {error}"));
        let target = Path::new(path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(fail)?;
        }
        let staged = target.with_extension(format!("tmp{}", std::process::id()));
        std::fs::write(&staged, data).map_err(fail)?;
        std::fs::rename(&staged, target).map_err(fail)
    }
}

fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut bytes);
        }
        bytes
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_returns_output_and_status() {
        let output = LocalHost
            .exec(ExecRequest::new(["sh", "-c", "cat; echo err >&2; exit 3"]).stdin("in"))
            .unwrap();
        assert_eq!(output.status, Some(3));
        assert_eq!(output.stdout, b"in");
        assert_eq!(output.stderr, b"err\n");
        assert!(!output.success());
    }

    #[test]
    fn exec_runs_in_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().canonicalize().unwrap();
        let output = LocalHost
            .exec(ExecRequest::new(["pwd"]).cwd(cwd.to_str().unwrap()))
            .unwrap();
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            cwd.to_str().unwrap()
        );
    }

    #[test]
    fn exec_times_out() {
        let output = LocalHost
            .exec(ExecRequest::new(["sleep", "5"]).timeout(Duration::from_millis(100)))
            .unwrap();
        assert!(output.timed_out);
        assert_eq!(output.status, None);
    }

    #[test]
    fn missing_program_is_not_found() {
        let error = LocalHost
            .exec(ExecRequest::new(["no-such-program-xyz"]))
            .unwrap_err();
        assert!(matches!(error, HostError::NotFound(_)));
    }

    #[test]
    fn files_round_trip_and_make_parents() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a/b/notes.json");
        let path = path.to_str().unwrap();
        assert!(matches!(
            LocalHost.read_file(path),
            Err(HostError::NotFound(_))
        ));
        LocalHost.write_file(path, b"one").unwrap();
        LocalHost.write_file(path, b"two").unwrap();
        assert_eq!(LocalHost.read_file(path).unwrap(), b"two");
    }
}
