//! Preferences in one JSON file under the platform config dir. Set `CODEDUCKY_CONFIG_DIR` to
//! keep them elsewhere (dev scripting does, so it never touches the real file).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::theme::{Appearance, Density, Palette};

const FILE: &str = "prefs.json";
const MAX_RECENT: usize = 12;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffMode {
    #[default]
    Unified,
    Split,
}

/// The mode a repository's review opens in. Commit picks are not kept: commits come and go.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SavedMode {
    #[default]
    All,
    Since,
}

/// `machine:path`, or the path alone on this machine.
pub fn repo_key(machine: Option<&str>, path: &str) -> String {
    match machine {
        Some(machine) => format!("{machine}:{path}"),
        None => path.to_owned(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecentRepo {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
}

/// The agents panel under the diff.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PanelPrefs {
    pub open: bool,
    /// Logical pixels.
    pub height: f32,
}

impl Default for PanelPrefs {
    fn default() -> Self {
        Self {
            open: false,
            height: 300.,
        }
    }
}

pub const DEFAULT_AGENT_COMMAND: &str = "claude";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Prefs {
    pub appearance: Appearance,
    pub palette: Palette,
    pub density: Density,
    pub diff_mode: DiffMode,
    pub wrap: bool,
    pub ignore_whitespace: bool,
    pub recent: Vec<RecentRepo>,
    /// Width and height in logical pixels.
    pub window: Option<(f32, f32)>,
    pub agents: PanelPrefs,
    /// The command the start-agent dialog offered last; empty for the default.
    pub agent_command: String,
    /// The machine the start screen had picked; `None` for this one.
    pub machine: Option<String>,
    /// The last mode per repository ([`repo_key`]).
    pub modes: std::collections::BTreeMap<String, SavedMode>,
}

impl Prefs {
    /// Kept per machine: each machine keeps its own most recent repos.
    pub fn remember(&mut self, repo: RecentRepo) {
        self.recent.retain(|r| *r != repo);
        self.recent.insert(0, repo);
        let mut kept = 0;
        let machine = self.recent[0].machine.clone();
        self.recent.retain(|r| {
            if r.machine != machine {
                return true;
            }
            kept += 1;
            kept <= MAX_RECENT
        });
    }

    pub fn recent_on(&self, machine: Option<&str>) -> impl Iterator<Item = &RecentRepo> {
        self.recent
            .iter()
            .filter(move |r| r.machine.as_deref() == machine)
    }

    /// After a machine is renamed, its recent repos follow it; after it is forgotten, they go.
    pub fn rename_machine(&mut self, from: &str, to: Option<&str>) {
        if self.machine.as_deref() == Some(from) {
            self.machine = to.map(str::to_owned);
        }
        match to {
            Some(to) => {
                for repo in &mut self.recent {
                    if repo.machine.as_deref() == Some(from) {
                        repo.machine = Some(to.to_owned());
                    }
                }
            }
            None => self.recent.retain(|r| r.machine.as_deref() != Some(from)),
        }
    }

    pub fn mode_for(&self, repo: &str) -> SavedMode {
        self.modes.get(repo).copied().unwrap_or_default()
    }

    pub fn set_mode(&mut self, repo: String, mode: SavedMode) {
        match mode {
            SavedMode::All => self.modes.remove(&repo),
            SavedMode::Since => self.modes.insert(repo, mode),
        };
    }

    pub fn agent_command(&self) -> &str {
        match self.agent_command.trim() {
            "" => DEFAULT_AGENT_COMMAND,
            command => command,
        }
    }
}

pub fn config_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CODEDUCKY_CONFIG_DIR") {
        return Some(PathBuf::from(dir));
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let base = if cfg!(target_os = "macos") {
        home.map(|home| home.join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| home.map(|home| home.join(".config")))
    };
    base.map(|base| base.join("codeducky"))
}

pub fn load() -> Prefs {
    config_dir()
        .and_then(|dir| std::fs::read(dir.join(FILE)).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn save(prefs: &Prefs) -> std::io::Result<()> {
    let dir = config_dir().ok_or_else(|| std::io::Error::other("no config dir"))?;
    std::fs::create_dir_all(&dir)?;
    let json = serde_json::to_vec_pretty(prefs).map_err(std::io::Error::other)?;
    let tmp = dir.join(format!("{FILE}.tmp"));
    std::fs::write(&tmp, json)?;
    std::fs::rename(tmp, dir.join(FILE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_recent_repos_unique_and_newest_first() {
        let mut prefs = Prefs::default();
        let repo = |path: &str| RecentRepo {
            path: path.into(),
            machine: None,
        };
        prefs.remember(repo("/a"));
        prefs.remember(repo("/b"));
        prefs.remember(repo("/a"));
        assert_eq!(prefs.recent, [repo("/a"), repo("/b")]);
    }

    #[test]
    fn recent_repos_are_kept_per_machine() {
        let mut prefs = Prefs::default();
        let on = |path: &str, machine: Option<&str>| RecentRepo {
            path: path.into(),
            machine: machine.map(str::to_owned),
        };
        for i in 0..MAX_RECENT {
            prefs.remember(on(&format!("/r{i}"), None));
        }
        prefs.remember(on("/srv/app", Some("vps")));
        prefs.remember(on("/last", None));
        assert_eq!(prefs.recent_on(None).count(), MAX_RECENT);
        assert_eq!(prefs.recent_on(Some("vps")).count(), 1);
        assert_eq!(prefs.recent_on(None).next().unwrap().path, "/last");

        prefs.machine = Some("vps".into());
        prefs.rename_machine("vps", Some("lab"));
        assert_eq!(prefs.recent_on(Some("lab")).count(), 1);
        assert_eq!(prefs.machine.as_deref(), Some("lab"));
        prefs.rename_machine("lab", None);
        assert_eq!(prefs.recent_on(Some("lab")).count(), 0);
        assert_eq!(prefs.machine, None);
    }

    #[test]
    fn remembers_since_mode_per_repo() {
        let mut prefs = Prefs::default();
        let key = repo_key(Some("lab"), "/srv/app");
        assert_eq!(key, "lab:/srv/app");
        prefs.set_mode(key.clone(), SavedMode::Since);
        assert_eq!(prefs.mode_for(&key), SavedMode::Since);
        assert_eq!(prefs.mode_for("/srv/app"), SavedMode::All);
        prefs.set_mode(key.clone(), SavedMode::All);
        assert!(prefs.modes.is_empty());
    }

    #[test]
    fn reads_partial_files_with_defaults() {
        let prefs: Prefs = serde_json::from_str(r#"{"palette": "fjord"}"#).unwrap();
        assert_eq!(prefs.palette, Palette::Fjord);
        assert_eq!(prefs.density, Density::Default);
        assert_eq!(prefs.agents, PanelPrefs::default());
        assert_eq!(prefs.agent_command(), "claude");
    }
}
