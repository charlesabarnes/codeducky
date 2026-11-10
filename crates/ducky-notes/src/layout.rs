use ducky_host::{ExecRequest, Host};
use ducky_review::ReviewTarget;

use crate::error::NotesError;

pub const FOLDER: &str = "codeducky";
pub const README: &str = "README.md";
pub const CHECKLISTS: &str = "checklists.json";
pub const NOTES: &str = "notes.json";
pub const STATE: &str = "state.json";

pub fn join(dir: &str, name: &str) -> String {
    format!("{}/{name}", dir.trim_end_matches('/'))
}

/// `branches/<branch>` (a branch name is already a valid relative path) or `pulls/<number>`.
pub fn review_dir(root: &str, target: &ReviewTarget) -> Result<String, NotesError> {
    match target {
        ReviewTarget::Branch { branch } => {
            let valid = !branch.is_empty()
                && !branch.contains(['\\', '\0'])
                && branch
                    .split('/')
                    .all(|part| !matches!(part, "" | "." | ".."));
            if !valid {
                return Err(NotesError::InvalidBranch(branch.clone()));
            }
            Ok(join(&join(root, "branches"), branch))
        }
        ReviewTarget::PullRequest { number } => Ok(join(&join(root, "pulls"), &number.to_string())),
    }
}

/// The absolute git common dir of the repo at `repo`: shared by all its worktrees.
pub fn git_common_dir(host: &dyn Host, repo: &str) -> Result<String, NotesError> {
    let request = ExecRequest::new([
        "git",
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
    ])
    .cwd(repo);
    let output = host.exec(request)?;
    let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).trim().to_owned();
    if !output.success() {
        return Err(NotesError::Git {
            repo: repo.to_owned(),
            message: text(&output.stderr),
        });
    }
    Ok(text(&output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nests_branch_names_and_numbers_pulls() {
        let dir = |target| review_dir("/r/.git/codeducky", &target);
        assert_eq!(
            dir(ReviewTarget::branch("feature/login")).unwrap(),
            "/r/.git/codeducky/branches/feature/login"
        );
        assert_eq!(
            dir(ReviewTarget::pull_request(42)).unwrap(),
            "/r/.git/codeducky/pulls/42"
        );
        for bad in ["", "../x", "a//b", "a/./b", "/abs"] {
            assert!(dir(ReviewTarget::branch(bad)).is_err(), "{bad}");
        }
    }
}
