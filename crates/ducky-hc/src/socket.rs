//! Where the core's socket is, following `hc`'s own precedence (herdr-core 0.1.19 `paths.rs`).

use std::path::{Path, PathBuf};

/// The inputs to socket discovery, read once so discovery itself stays pure.
#[derive(Debug, Clone, Default)]
pub struct SocketEnv {
    pub hc_socket: Option<String>,
    pub hc_session: Option<String>,
    pub xdg_runtime_dir: Option<String>,
    pub xdg_state_home: Option<String>,
    pub xdg_config_home: Option<String>,
    pub home: Option<String>,
    /// `/run/user/<uid>`, when that folder exists.
    pub run_user_dir: Option<String>,
    /// The `socket = "..."` value from `config.toml`, when there is one.
    pub config_socket: Option<String>,
}

impl SocketEnv {
    /// Inside Flatpak, `XDG_STATE_HOME` and `XDG_CONFIG_HOME` point into the sandbox, not at the
    /// core's files, so they are ignored there in favour of the home defaults.
    pub fn from_process() -> Self {
        let var = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        let sandboxed = var("FLATPAK_ID").is_some();
        let mut env = Self {
            hc_socket: var("HC_SOCKET"),
            hc_session: var("HC_SESSION"),
            xdg_runtime_dir: var("XDG_RUNTIME_DIR"),
            xdg_state_home: var("XDG_STATE_HOME").filter(|_| !sandboxed),
            xdg_config_home: var("XDG_CONFIG_HOME").filter(|_| !sandboxed),
            home: var("HOME"),
            run_user_dir: run_user_dir(),
            config_socket: None,
        };
        env.config_socket = std::fs::read_to_string(env.config_dir().join("config.toml"))
            .ok()
            .and_then(|text| config_socket(&text));
        env
    }

    pub fn session(&self) -> String {
        self.hc_session
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("default")
            .to_owned()
    }

    fn home(&self) -> PathBuf {
        PathBuf::from(self.home.clone().unwrap_or_else(|| "/".into()))
    }

    fn config_dir(&self) -> PathBuf {
        self.xdg_config_home
            .as_ref()
            .map_or_else(|| self.home().join(".config"), PathBuf::from)
            .join("herdr-core")
    }

    fn state_dir(&self) -> PathBuf {
        self.xdg_state_home
            .as_ref()
            .map_or_else(|| self.home().join(".local/state"), PathBuf::from)
            .join("herdr-core")
            .join(self.session())
    }
}

/// `HC_SOCKET`, then `socket` in config.toml, then the runtime dir, then beside the state.
pub fn discover(env: &SocketEnv) -> PathBuf {
    if let Some(socket) = &env.hc_socket {
        return PathBuf::from(socket);
    }
    if let Some(socket) = &env.config_socket {
        return PathBuf::from(socket);
    }
    let file = format!("{}.sock", env.session());
    if let Some(runtime) = env.xdg_runtime_dir.as_ref().or(env.run_user_dir.as_ref()) {
        return Path::new(runtime).join("herdr-core").join(file);
    }
    env.state_dir().join(file)
}

/// Only a top-level `socket = "..."`; everything else in the file is the core's business.
fn config_socket(text: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            return None;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != "socket" {
            continue;
        }
        let value = value.trim();
        let value = value.split(" #").next().unwrap_or(value).trim();
        return unquote(value);
    }
    None
}

fn unquote(value: &str) -> Option<String> {
    if let Some(inner) = value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')) {
        return Some(inner.to_owned());
    }
    let inner = value.strip_prefix('"')?.strip_suffix('"')?;
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next()? {
            'n' => out.push('\n'),
            't' => out.push('\t'),
            other => out.push(other),
        }
    }
    Some(out)
}

#[cfg(target_os = "linux")]
fn run_user_dir() -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let uid = std::fs::metadata("/proc/self").ok()?.uid();
    let dir = format!("/run/user/{uid}");
    Path::new(&dir).is_dir().then_some(dir)
}

#[cfg(not(target_os = "linux"))]
fn run_user_dir() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> SocketEnv {
        SocketEnv {
            home: Some("/home/u".into()),
            ..SocketEnv::default()
        }
    }

    #[test]
    fn precedence() {
        let cases = [
            (
                home(),
                "/home/u/.local/state/herdr-core/default/default.sock",
            ),
            (
                SocketEnv {
                    hc_session: Some(" dev ".into()),
                    xdg_state_home: Some("/s".into()),
                    ..home()
                },
                "/s/herdr-core/dev/dev.sock",
            ),
            (
                SocketEnv {
                    run_user_dir: Some("/run/user/1000".into()),
                    ..home()
                },
                "/run/user/1000/herdr-core/default.sock",
            ),
            (
                SocketEnv {
                    xdg_runtime_dir: Some("/r".into()),
                    run_user_dir: Some("/run/user/1000".into()),
                    ..home()
                },
                "/r/herdr-core/default.sock",
            ),
            (
                SocketEnv {
                    config_socket: Some("/c.sock".into()),
                    xdg_runtime_dir: Some("/r".into()),
                    ..home()
                },
                "/c.sock",
            ),
            (
                SocketEnv {
                    hc_socket: Some("/e.sock".into()),
                    config_socket: Some("/c.sock".into()),
                    ..home()
                },
                "/e.sock",
            ),
        ];
        for (env, expected) in cases {
            assert_eq!(discover(&env), PathBuf::from(expected), "{env:?}");
        }
    }

    #[test]
    fn reads_only_the_top_level_socket_key() {
        assert_eq!(
            config_socket("# hi\nsocket = \"/tmp/a b.sock\" # note\n"),
            Some("/tmp/a b.sock".into())
        );
        assert_eq!(config_socket("socket='/x'"), Some("/x".into()));
        assert_eq!(config_socket("[remote]\nsocket = \"/no\"\n"), None);
        assert_eq!(config_socket("sockets = \"/no\"\n"), None);
        assert_eq!(config_socket("socket = \"a\\\\b\""), Some("a\\b".into()));
    }
}
