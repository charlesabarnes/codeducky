use crate::change::{BranchCommit, short_sha};

/// A contiguous run of the branch's commits, as indexes into the list (oldest first); `from ==
/// to` for one commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommitRange {
    pub from: usize,
    pub to: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Back,
    Forward,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("that commit is no longer on the branch")]
pub struct CommitGone;

/// The two commits a range diffs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RangeEnds {
    /// The first commit's first parent; `None` for a root commit.
    pub base: Option<String>,
    pub head: String,
}

impl CommitRange {
    pub fn single(index: usize) -> Self {
        Self {
            from: index,
            to: index,
        }
    }

    pub fn is_single(self) -> bool {
        self.from == self.to
    }

    pub fn ends(self, commits: &[BranchCommit]) -> Result<RangeEnds, CommitGone> {
        let (first, last) = (commits.get(self.from), commits.get(self.to));
        let (Some(first), Some(last)) = (first, last) else {
            return Err(CommitGone);
        };
        Ok(RangeEnds {
            base: first.parents.first().cloned(),
            head: last.sha.clone(),
        })
    }

    /// Shift-click: extends the range to include `index`, keeping it contiguous.
    pub fn extend(range: Option<Self>, index: usize) -> Self {
        range.map_or(Self::single(index), |range| Self {
            from: range.from.min(index),
            to: range.to.max(index),
        })
    }

    /// e.g. `abc1234 Fix the retry loop`, or `3 commits, abc1234..def5678`.
    pub fn describe(self, commits: &[BranchCommit]) -> String {
        let (Some(first), Some(last)) = (commits.get(self.from), commits.get(self.to)) else {
            return String::new();
        };
        if self.is_single() {
            return format!("{} {}", first.short_sha(), first.summary());
        }
        format!(
            "{} commits, {}..{}",
            self.to - self.from + 1,
            short_sha(&first.sha),
            short_sha(&last.sha)
        )
    }

    /// Finds a range again by its commits' shas after the list reloads; `None` when they are gone.
    pub fn find(commits: &[BranchCommit], from_sha: &str, to_sha: &str) -> Option<Self> {
        let position = |sha: &str| commits.iter().position(|commit| commit.sha == sha);
        let (from, to) = (position(from_sha)?, position(to_sha)?);
        (to >= from).then_some(Self { from, to })
    }
}

/// The next view when stepping commit by commit: from All changes (`None`) forward goes to the
/// first commit and back to the last; past either end it returns to All changes. A range steps
/// as a whole from its edge.
pub fn step_commit(range: Option<CommitRange>, count: usize, step: Step) -> Option<CommitRange> {
    if count == 0 {
        return None;
    }
    let index = match (range, step) {
        (None, Step::Forward) => 0,
        (None, Step::Back) => count - 1,
        (Some(range), Step::Forward) => range.to + 1,
        (Some(range), Step::Back) => range.from.checked_sub(1)?,
    };
    (index < count).then_some(CommitRange::single(index))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::Timestamp;

    fn commit(sha: String, parents: &[String], message: &str) -> BranchCommit {
        BranchCommit {
            sha,
            parents: parents.to_vec(),
            message: message.into(),
            author: "A".into(),
            date: Timestamp(0),
        }
    }

    fn sha(c: char) -> String {
        c.to_string().repeat(40)
    }

    fn commits() -> Vec<BranchCommit> {
        vec![
            commit(sha('a'), &["base".into()], "First\n\nbody"),
            commit(sha('b'), &[sha('a'), sha('m')], "Merge main"),
            commit(sha('c'), &[sha('b')], "Third"),
        ]
    }

    fn range(from: usize, to: usize) -> CommitRange {
        CommitRange { from, to }
    }

    #[test]
    fn steps_from_all_changes_through_each_commit_and_back() {
        assert_eq!(step_commit(None, 3, Step::Forward), Some(range(0, 0)));
        assert_eq!(step_commit(None, 3, Step::Back), Some(range(2, 2)));
        assert_eq!(
            step_commit(Some(range(0, 0)), 3, Step::Forward),
            Some(range(1, 1))
        );
        assert_eq!(step_commit(Some(range(2, 2)), 3, Step::Forward), None);
        assert_eq!(step_commit(Some(range(0, 0)), 3, Step::Back), None);
        assert_eq!(
            step_commit(Some(range(0, 1)), 3, Step::Forward),
            Some(range(2, 2))
        );
        assert_eq!(step_commit(None, 0, Step::Forward), None);
    }

    #[test]
    fn extends_a_pick_into_a_contiguous_range_either_way() {
        assert_eq!(CommitRange::extend(None, 1), range(1, 1));
        assert_eq!(CommitRange::extend(Some(range(1, 1)), 2), range(1, 2));
        assert_eq!(CommitRange::extend(Some(range(1, 2)), 0), range(0, 2));
    }

    #[test]
    fn diffs_a_range_from_the_first_commits_first_parent_to_the_last_commit() {
        let commits = commits();
        assert_eq!(
            range(1, 1).ends(&commits),
            Ok(RangeEnds {
                base: Some(sha('a')),
                head: sha('b')
            })
        );
        assert_eq!(
            range(0, 2).ends(&commits),
            Ok(RangeEnds {
                base: Some("base".into()),
                head: sha('c')
            })
        );
        let root = [commit(sha('r'), &[], "root")];
        assert_eq!(range(0, 0).ends(&root).unwrap().base, None);
        assert_eq!(range(4, 4).ends(&commits), Err(CommitGone));
    }

    #[test]
    fn describes_and_finds_ranges_by_sha() {
        let commits = commits();
        assert_eq!(range(0, 0).describe(&commits), "aaaaaaa First");
        assert_eq!(
            range(0, 2).describe(&commits),
            "3 commits, aaaaaaa..ccccccc"
        );
        assert_eq!(
            CommitRange::find(&commits, &sha('b'), &sha('c')),
            Some(range(1, 2))
        );
        assert_eq!(CommitRange::find(&commits, &sha('c'), &sha('a')), None);
        assert_eq!(CommitRange::find(&commits, "x", &sha('c')), None);
    }
}
