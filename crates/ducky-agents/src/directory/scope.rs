//! Which terminals belong to a repo: on its machine, started in or now working in one of its
//! folders (the toplevel and any worktrees).

use ducky_hc::Terminal;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectoryScope {
    machine: Option<String>,
    roots: Vec<String>,
}

impl DirectoryScope {
    /// `machine` is `None` for this machine; `repo_root` is the repo's toplevel there.
    pub fn new(machine: Option<String>, repo_root: impl Into<String>) -> Self {
        Self {
            machine,
            roots: vec![normalize(&repo_root.into())],
        }
    }

    pub fn with_worktrees(
        mut self,
        worktrees: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        for worktree in worktrees {
            self.add_root(&worktree.into());
        }
        self
    }

    /// On this machine, also match each folder's resolved path: the OS reports a program's
    /// folder resolved (`/private/tmp/x` for `/tmp/x` on macOS).
    pub fn with_local_aliases(mut self) -> Self {
        if self.machine.is_none() {
            let resolved: Vec<String> = self
                .roots
                .iter()
                .filter_map(|root| std::fs::canonicalize(root).ok())
                .filter_map(|path| path.to_str().map(str::to_owned))
                .collect();
            for root in resolved {
                self.add_root(&root);
            }
        }
        self
    }

    fn add_root(&mut self, root: &str) {
        let root = normalize(root);
        if !self.roots.contains(&root) {
            self.roots.push(root);
        }
    }

    pub fn machine(&self) -> Option<&str> {
        self.machine.as_deref()
    }

    pub fn roots(&self) -> &[String] {
        &self.roots
    }

    pub fn contains_path(&self, path: &str) -> bool {
        let path = normalize(path);
        self.roots
            .iter()
            .any(|root| root == "/" || path == *root || path.starts_with(&format!("{root}/")))
    }

    pub fn on_machine(&self, address: &str) -> bool {
        machine_of(address) == self.machine.as_deref()
    }

    pub fn matches(&self, terminal: &Terminal) -> bool {
        self.on_machine(&terminal.address)
            && (self.contains_path(&terminal.cwd)
                || terminal
                    .foreground
                    .as_ref()
                    .is_some_and(|fg| self.contains_path(&fg.cwd)))
    }
}

/// `vps` for `vps/t3`, `None` for `t3`.
pub fn machine_of(address: &str) -> Option<&str> {
    address.split_once('/').map(|(machine, _)| machine)
}

fn normalize(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".into()
    } else {
        trimmed.into()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::test_support::terminal;

    #[test]
    fn folders_inside_any_root_match_on_the_same_machine() {
        let scope = DirectoryScope::new(None, "/src/shop/").with_worktrees(["/src/shop-fix"]);
        assert!(scope.contains_path("/src/shop"));
        assert!(scope.contains_path("/src/shop/web/"));
        assert!(scope.contains_path("/src/shop-fix/a"));
        assert!(!scope.contains_path("/src/shopping"));
        assert!(!scope.contains_path("/src"));

        let launched = terminal(json!({"cwd": "/src/shop/web"}));
        assert!(scope.matches(&launched));
        let elsewhere = terminal(json!({"cwd": "/home"}));
        assert!(!scope.matches(&elsewhere));
        let moved_in = terminal(json!({"cwd": "/home", "foreground": {
            "pid": 1, "name": "zsh", "argv": ["zsh"], "cwd": "/src/shop"}}));
        assert!(scope.matches(&moved_in));
        let remote = terminal(json!({"address": "vps/t1", "cwd": "/src/shop"}));
        assert!(!scope.matches(&remote));
    }

    #[test]
    fn a_remote_scope_matches_only_that_machine() {
        let scope = DirectoryScope::new(Some("vps".into()), "/srv/app");
        assert!(scope.on_machine("vps/t3"));
        assert!(!scope.on_machine("t3"));
        assert!(!scope.on_machine("other/t3"));
        assert_eq!(machine_of("vps/t3"), Some("vps"));
    }

    #[test]
    fn local_aliases_add_resolved_paths() {
        let dir = std::env::temp_dir();
        let scope = DirectoryScope::new(None, dir.to_str().unwrap()).with_local_aliases();
        let resolved = std::fs::canonicalize(&dir).unwrap();
        assert!(scope.contains_path(resolved.to_str().unwrap()));
    }
}
