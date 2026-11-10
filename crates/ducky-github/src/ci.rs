//! CI for a commit: check runs, commit statuses and check annotations, and where annotations sit
//! in a file.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use crate::api::checks::{
    CheckAnnotation, CheckConclusion, CheckRun, CheckStatus, CommitStatus, StatusState,
};
use crate::client::Client;
use crate::error::Result;
use crate::remote::RepoRef;

const ANNOTATION_THREADS: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CiState {
    Pass,
    Fail,
    Pending,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunState {
    Pass,
    Fail,
    Pending,
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CiSummary {
    pub state: CiState,
    pub passed: usize,
    pub failed: usize,
    pub pending: usize,
    pub skipped: usize,
}

pub fn run_state(run: &CheckRun) -> RunState {
    use CheckConclusion as C;
    if run.status != CheckStatus::Completed {
        return RunState::Pending;
    }
    match run.conclusion {
        Some(C::Failure | C::TimedOut | C::Cancelled | C::ActionRequired | C::Stale) => {
            RunState::Fail
        }
        Some(C::Skipped | C::Neutral) => RunState::Skipped,
        _ => RunState::Pass,
    }
}

pub fn status_state(status: &CommitStatus) -> RunState {
    match status.state {
        StatusState::Success => RunState::Pass,
        StatusState::Failure | StatusState::Error => RunState::Fail,
        StatusState::Pending => RunState::Pending,
        StatusState::Unknown => RunState::Skipped,
    }
}

/// Failing beats pending beats passing, as on GitHub's status icon.
pub fn summarize(states: impl IntoIterator<Item = RunState>) -> CiSummary {
    let mut summary = CiSummary {
        state: CiState::None,
        passed: 0,
        failed: 0,
        pending: 0,
        skipped: 0,
    };
    for state in states {
        match state {
            RunState::Pass => summary.passed += 1,
            RunState::Fail => summary.failed += 1,
            RunState::Pending => summary.pending += 1,
            RunState::Skipped => summary.skipped += 1,
        }
    }
    let any = summary.passed + summary.failed + summary.pending + summary.skipped > 0;
    summary.state = if summary.failed > 0 {
        CiState::Fail
    } else if summary.pending > 0 {
        CiState::Pending
    } else if any {
        CiState::Pass
    } else {
        CiState::None
    };
    summary
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CiSnapshot {
    pub sha: String,
    pub runs: Vec<CheckRun>,
    pub statuses: Vec<CommitStatus>,
    /// In run order, then by line.
    pub annotations: Vec<CheckAnnotation>,
}

impl CiSnapshot {
    pub fn summary(&self) -> CiSummary {
        summarize(
            self.runs
                .iter()
                .map(run_state)
                .chain(self.statuses.iter().map(status_state)),
        )
    }
}

/// Check runs, statuses and every run's annotations; `None` when GitHub does not have the commit.
pub fn fetch_ci(client: &Client, repo: &RepoRef, sha: &str) -> Result<Option<CiSnapshot>> {
    let Some(runs) = client.check_runs(repo, sha)? else {
        return Ok(None);
    };
    let statuses = client.commit_statuses(repo, sha)?.unwrap_or_default();
    let queue: Mutex<Vec<u64>> = Mutex::new(
        runs.iter()
            .filter(|r| r.annotations_count > 0)
            .map(|r| r.id)
            .rev()
            .collect(),
    );
    let workers = ANNOTATION_THREADS.min(queue.lock().map_or(0, |q| q.len()));
    let fetched: Vec<Result<Vec<CheckAnnotation>>> = thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                scope.spawn(|| {
                    let mut out = Vec::new();
                    while let Some(id) = queue.lock().ok().and_then(|mut q| q.pop()) {
                        out.push(client.check_run_annotations(repo, id));
                    }
                    out
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap_or_default())
            .collect()
    });
    let order: HashMap<u64, usize> = runs.iter().enumerate().map(|(i, r)| (r.id, i)).collect();
    let mut annotations = Vec::new();
    for batch in fetched {
        annotations.extend(batch?);
    }
    annotations.sort_by_key(|a| (order.get(&a.check_run_id).copied(), a.start_line));
    Ok(Some(CiSnapshot {
        sha: sha.to_owned(),
        runs,
        statuses,
        annotations,
    }))
}

/// The wait before the next poll while checks are pending: 10 s, 20 s, 40 s, then every minute.
pub fn poll_delay(attempt: u32) -> Duration {
    Duration::from_secs((10u64 << attempt.min(3)).min(60))
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AnnotationsByFile {
    pub by_path: BTreeMap<String, Vec<CheckAnnotation>>,
    /// Annotations on paths that are not in the change set.
    pub elsewhere: Vec<CheckAnnotation>,
}

pub fn group_annotations(
    annotations: &[CheckAnnotation],
    paths: &HashSet<&str>,
) -> AnnotationsByFile {
    let mut grouped = AnnotationsByFile::default();
    for annotation in annotations {
        if paths.contains(annotation.path.as_str()) {
            grouped
                .by_path
                .entry(annotation.path.clone())
                .or_default()
                .push(annotation.clone());
        } else {
            grouped.elsewhere.push(annotation.clone());
        }
    }
    grouped
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileForAnnotations {
    /// Lines in the version shown; `None` when it was deleted or is not text.
    pub new_line_count: Option<u32>,
    /// False when the shown version differs from the commit the checks ran on.
    pub matches_checked_commit: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnplacedAnnotation {
    pub annotation: CheckAnnotation,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlacedAnnotations {
    /// New-side line to the annotations ending on it (GitHub shows multi-line ones at the end).
    pub by_line: BTreeMap<u32, Vec<CheckAnnotation>>,
    pub unplaced: Vec<UnplacedAnnotation>,
}

pub fn place_annotations(
    annotations: &[CheckAnnotation],
    file: FileForAnnotations,
) -> PlacedAnnotations {
    let mut placed = PlacedAnnotations::default();
    for annotation in annotations {
        let line = if annotation.end_line > 0 {
            annotation.end_line
        } else {
            annotation.start_line
        };
        let reason = match file.new_line_count {
            None => Some("The file has no text in the working tree".to_owned()),
            Some(_) if !file.matches_checked_commit => {
                Some("The file changed since the checked commit".to_owned())
            }
            Some(_) if line < 1 => Some("Not on a line".to_owned()),
            Some(count) if line > count => Some(format!("Line {line} is past the end of the file")),
            Some(_) => None,
        };
        match reason {
            Some(reason) => placed.unplaced.push(UnplacedAnnotation {
                annotation: annotation.clone(),
                reason,
            }),
            None => placed
                .by_line
                .entry(line)
                .or_default()
                .push(annotation.clone()),
        }
    }
    placed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::checks::AnnotationLevel;

    fn run(status: CheckStatus, conclusion: Option<CheckConclusion>) -> CheckRun {
        CheckRun {
            id: 1,
            name: "job".into(),
            status,
            conclusion,
            html_url: None,
            details_url: None,
            title: None,
            annotations_count: 0,
            app: None,
        }
    }

    fn annotation(path: &str, start: u32, end: u32) -> CheckAnnotation {
        CheckAnnotation {
            check_run_id: 1,
            path: path.into(),
            start_line: start,
            end_line: end,
            level: AnnotationLevel::Failure,
            title: None,
            message: "x".into(),
            raw_details: None,
        }
    }

    fn summary(runs: &[CheckRun]) -> CiSummary {
        summarize(runs.iter().map(run_state))
    }

    #[test]
    fn fails_if_any_failed_else_pends_else_passes() {
        use CheckConclusion as C;
        use CheckStatus as S;
        assert_eq!(summary(&[]).state, CiState::None);
        let pass = summary(&[
            run(S::Completed, Some(C::Success)),
            run(S::Completed, Some(C::Skipped)),
        ]);
        assert_eq!(
            (pass.state, pass.passed, pass.skipped),
            (CiState::Pass, 1, 1)
        );
        let pending = summary(&[run(S::Completed, Some(C::Success)), run(S::Queued, None)]);
        assert_eq!((pending.state, pending.pending), (CiState::Pending, 1));
        let fail = summary(&[
            run(S::InProgress, None),
            run(S::Completed, Some(C::TimedOut)),
        ]);
        assert_eq!((fail.state, fail.failed), (CiState::Fail, 1));
    }

    #[test]
    fn statuses_count_with_runs() {
        let status = CommitStatus {
            context: "ci/jenkins".into(),
            state: StatusState::Error,
            description: None,
            target_url: None,
        };
        assert_eq!(status_state(&status), RunState::Fail);
    }

    #[test]
    fn backs_off_to_a_minute() {
        let delays: Vec<u64> = [0, 1, 2, 3, 9].map(|a| poll_delay(a).as_secs()).to_vec();
        assert_eq!(delays, [10, 20, 40, 60, 60]);
    }

    #[test]
    fn groups_by_changed_path() {
        let all = [
            annotation("a.ts", 1, 1),
            annotation("b.ts", 2, 2),
            annotation("a.ts", 3, 3),
        ];
        let grouped = group_annotations(&all, &HashSet::from(["a.ts"]));
        let lines: Vec<u32> = grouped.by_path["a.ts"]
            .iter()
            .map(|a| a.start_line)
            .collect();
        assert_eq!(lines, [1, 3]);
        assert_eq!(grouped.elsewhere[0].path, "b.ts");
    }

    #[test]
    fn places_annotations_on_their_last_line() {
        let all = [
            annotation("a.ts", 4, 4),
            annotation("a.ts", 5, 7),
            annotation("a.ts", 99, 99),
            annotation("a.ts", 0, 0),
        ];
        let file = FileForAnnotations {
            new_line_count: Some(10),
            matches_checked_commit: true,
        };
        let placed = place_annotations(&all, file);
        assert_eq!(placed.by_line.keys().copied().collect::<Vec<_>>(), [4, 7]);
        let reasons: Vec<&str> = placed.unplaced.iter().map(|u| u.reason.as_str()).collect();
        assert_eq!(
            reasons,
            ["Line 99 is past the end of the file", "Not on a line"]
        );
    }

    #[test]
    fn does_not_place_on_changed_or_deleted_files() {
        let changed = place_annotations(
            &[annotation("a.ts", 4, 4)],
            FileForAnnotations {
                new_line_count: Some(10),
                matches_checked_commit: false,
            },
        );
        assert!(changed.by_line.is_empty());
        assert!(changed.unplaced[0].reason.contains("changed since"));
        let deleted = place_annotations(
            &[annotation("a.ts", 4, 4)],
            FileForAnnotations {
                new_line_count: None,
                matches_checked_commit: true,
            },
        );
        assert_eq!(deleted.unplaced.len(), 1);
    }
}
