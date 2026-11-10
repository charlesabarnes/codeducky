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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecentRepo {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
}

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
}

impl Prefs {
    pub fn remember(&mut self, repo: RecentRepo) {
        self.recent.retain(|r| *r != repo);
        self.recent.insert(0, repo);
        self.recent.truncate(MAX_RECENT);
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
    fn reads_partial_files_with_defaults() {
        let prefs: Prefs = serde_json::from_str(r#"{"palette": "fjord"}"#).unwrap();
        assert_eq!(prefs.palette, Palette::Fjord);
        assert_eq!(prefs.density, Density::Default);
    }
}
