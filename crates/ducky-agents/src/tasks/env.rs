//! The environment an agent starts with.
//!
//! A terminal inherits the core's environment plus what `terminal.run` sets; nothing can be
//! unset through the API. A core started from inside a Claude Code session (an `hc` command an
//! agent ran) carries that session's markers (`CLAUDECODE`, `CLAUDE_CODE_*`, ...), and a child
//! agent would take them as its own. So the core's `CLAUDE*` variables are set to empty, which
//! programs treat as unset. hc already replaces its own per-terminal `HC_*` variables, so only
//! the caller's extra variables are kept clear of `HC_*`.

use std::collections::BTreeMap;

/// The user's own settings, not a session's markers.
const KEPT: &[&str] = &["CLAUDE_CONFIG_DIR"];

fn is_session_marker(key: &str) -> bool {
    key.starts_with("CLAUDE") && !KEPT.contains(&key)
}

/// Variable names in `env` output (`KEY=value` per line; a value's own newlines may add a stray
/// name, which only means one more empty variable).
pub fn names_in_env_output(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, _)| key)
        .filter(|key| {
            !key.is_empty()
                && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && !key.starts_with(|c: char| c.is_ascii_digit())
        })
        .map(str::to_owned)
        .collect()
}

pub fn launch_env(
    core_vars: &[String],
    extra: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = core_vars
        .iter()
        .filter(|key| is_session_marker(key))
        .map(|key| (key.clone(), String::new()))
        .collect();
    env.extend(
        extra
            .iter()
            .filter(|(key, _)| !is_session_marker(key) && !key.starts_with("HC_"))
            .map(|(k, v)| (k.clone(), v.clone())),
    );
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_markers_are_blanked_and_the_callers_hc_vars_dropped() {
        let core = names_in_env_output(
            "PATH=/bin\nCLAUDECODE=1\nCLAUDE_CODE_ENTRYPOINT=cli\nCLAUDE_CONFIG_DIR=/c\nMULTI=a\nb=c\n1X=no\nHC_SESSION=x\n",
        );
        assert_eq!(
            core,
            [
                "PATH",
                "CLAUDECODE",
                "CLAUDE_CODE_ENTRYPOINT",
                "CLAUDE_CONFIG_DIR",
                "MULTI",
                "b",
                "HC_SESSION"
            ]
        );
        let extra = BTreeMap::from([
            ("HC_TERMINAL_ID".to_owned(), "t9".to_owned()),
            ("CLAUDECODE".to_owned(), "1".to_owned()),
            ("RUST_LOG".to_owned(), "debug".to_owned()),
        ]);
        let env = launch_env(&core, &extra);
        assert_eq!(
            env,
            BTreeMap::from([
                ("CLAUDECODE".to_owned(), String::new()),
                ("CLAUDE_CODE_ENTRYPOINT".to_owned(), String::new()),
                ("RUST_LOG".to_owned(), "debug".to_owned()),
            ])
        );
    }
}
