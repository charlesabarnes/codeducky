//! The labels Code Ducky puts on terminals it starts.

use ducky_hc::Labels;

/// `hc ls` shows this instead of the folder.
pub const WHERE: &str = "where";
pub const OWNER: &str = "codeducky";
pub const OWNER_VALUE: &str = "agent";
pub const REPO: &str = "codeducky-repo";
pub const TASK: &str = "codeducky-task";

pub fn started_by_ducky(labels: &Labels) -> bool {
    labels.get(OWNER).is_some_and(|v| v == OWNER_VALUE)
}

/// `Code Ducky / <repo folder>`.
pub fn where_label(repo_root: &str) -> String {
    let folder = repo_root
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|f| !f.is_empty())
        .unwrap_or(repo_root);
    format!("Code Ducky / {folder}")
}

pub fn for_launch(repo_root: &str, task: Option<&str>) -> Labels {
    let mut labels = Labels::new();
    labels.insert(OWNER.into(), OWNER_VALUE.into());
    labels.insert(REPO.into(), repo_root.into());
    labels.insert(WHERE.into(), where_label(repo_root));
    if let Some(task) = task {
        labels.insert(TASK.into(), task.into());
    }
    labels
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_labels_name_the_repo() {
        let labels = for_launch("/src/shop/", Some("fix"));
        assert!(started_by_ducky(&labels));
        assert_eq!(labels[WHERE], "Code Ducky / shop");
        assert_eq!(labels[TASK], "fix");
        assert_eq!(labels[REPO], "/src/shop/");
    }
}
