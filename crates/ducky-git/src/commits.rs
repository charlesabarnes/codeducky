use crate::model::FileChange;
use crate::repo::Repo;
use crate::runner::{Result, parse_error, text};

/// The picker's default cap.
pub const MAX_BRANCH_COMMITS: usize = 300;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Commit {
    pub sha: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    /// Author date, seconds since the epoch.
    pub author_time: i64,
    /// The full message, trailing whitespace trimmed; the first line is the summary.
    pub message: String,
}

impl Commit {
    pub fn summary(&self) -> &str {
        self.message.lines().next().unwrap_or_default()
    }

    pub fn is_merge(&self) -> bool {
        self.parents.len() > 1
    }

    pub fn short_sha(&self) -> &str {
        &self.sha[..self.sha.len().min(7)]
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitList {
    /// Oldest first.
    pub commits: Vec<Commit>,
    /// More commits were in the range than `limit`; the oldest ones are left out.
    pub truncated: bool,
}

const FIELDS: usize = 6;
const FORMAT: &str = "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%B";

impl Repo {
    /// `head`'s first parents back to (not including) anything reachable from `base`, oldest
    /// first. A merge of the base into the branch is listed (and `is_merge`), its second-parent
    /// history is not.
    pub fn commits(&self, base: &str, head: &str, limit: usize) -> Result<CommitList> {
        let max = format!("--max-count={}", limit + 1);
        let exclude = format!("^{base}");
        let args = [
            "log",
            "-z",
            "--first-parent",
            "--no-decorate",
            "--no-show-signature",
            FORMAT,
            &max,
            "--end-of-options",
            head,
            &exclude,
            "--",
        ];
        let out = self.git.run(&args)?;
        let mut commits = parse_log(&out).map_err(|detail| parse_error(&args, detail))?;
        let truncated = commits.len() > limit;
        commits.truncate(limit);
        commits.reverse();
        Ok(CommitList { commits, truncated })
    }

    /// What one commit changed against its first parent (the empty tree for a root commit).
    pub fn commit_changes(&self, commit: &Commit) -> Result<Vec<FileChange>> {
        self.changes_between(commit.parents.first().map(String::as_str), &commit.sha)
    }
}

fn parse_log(out: &[u8]) -> Result<Vec<Commit>, String> {
    let mut fields = out.split(|b| *b == 0).peekable();
    let mut commits = Vec::new();
    while fields.peek().is_some_and(|f| !f.is_empty()) {
        let record: Vec<String> = fields.by_ref().take(FIELDS).map(text).collect();
        let [sha, parents, name, email, time, message] = &record[..] else {
            return Err(format!("a commit with {} fields", record.len()));
        };
        commits.push(Commit {
            sha: sha.trim_start_matches('\n').to_owned(),
            parents: parents.split_whitespace().map(str::to_owned).collect(),
            author_name: name.clone(),
            author_email: email.clone(),
            author_time: time.parse().map_err(|_| format!("author time {time:?}"))?,
            message: message.trim_end().to_owned(),
        });
    }
    Ok(commits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_log_records_with_multiline_messages() {
        let out = b"bbb\0aaa ccc\0R\xc3\xa9ka\0r@x\x00200\x00Merge main\n\nbody\n\n\0aaa\0\0Al\0a@x\x00100\x00First\n\0";
        let commits = parse_log(out).unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].author_name, "Réka");
        assert!(commits[0].is_merge());
        assert_eq!(commits[0].message, "Merge main\n\nbody");
        assert!(commits[1].parents.is_empty());
        assert_eq!(commits[1].summary(), "First");
        assert!(parse_log(b"").unwrap().is_empty());
        assert!(parse_log(b"x\0y\0").is_err());
    }
}
