use serde::Deserialize;

use crate::client::{Client, or_none};
use crate::error::Result;
use crate::remote::RepoRef;
use crate::url::{encode, repo_path};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Queued,
    InProgress,
    Completed,
    Waiting,
    Requested,
    Pending,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckConclusion {
    Success,
    Failure,
    Neutral,
    Cancelled,
    Skipped,
    TimedOut,
    ActionRequired,
    Stale,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckRun {
    pub id: u64,
    pub name: String,
    pub status: CheckStatus,
    pub conclusion: Option<CheckConclusion>,
    pub html_url: Option<String>,
    pub details_url: Option<String>,
    pub title: Option<String>,
    pub annotations_count: u32,
    /// The app that ran it, e.g. `GitHub Actions`.
    pub app: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationLevel {
    Notice,
    Warning,
    Failure,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckAnnotation {
    pub check_run_id: u64,
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub level: AnnotationLevel,
    pub title: Option<String>,
    pub message: String,
    pub raw_details: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StatusState {
    Success,
    Pending,
    Failure,
    Error,
    #[serde(other)]
    Unknown,
}

/// A commit status from the older statuses API (external CI that does not use checks).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct CommitStatus {
    pub context: String,
    pub state: StatusState,
    pub description: Option<String>,
    pub target_url: Option<String>,
}

#[derive(Deserialize)]
struct RawRun {
    id: u64,
    name: String,
    status: CheckStatus,
    conclusion: Option<CheckConclusion>,
    html_url: Option<String>,
    details_url: Option<String>,
    output: Option<RawOutput>,
    app: Option<RawApp>,
}

#[derive(Deserialize)]
struct RawOutput {
    title: Option<String>,
    #[serde(default)]
    annotations_count: u32,
}

#[derive(Deserialize)]
struct RawApp {
    name: Option<String>,
}

#[derive(Deserialize)]
struct RawRuns {
    check_runs: Vec<RawRun>,
}

#[derive(Deserialize)]
struct RawAnnotation {
    path: String,
    start_line: u32,
    end_line: Option<u32>,
    annotation_level: AnnotationLevel,
    title: Option<String>,
    message: String,
    raw_details: Option<String>,
}

#[derive(Deserialize)]
struct RawCombined {
    statuses: Vec<CommitStatus>,
}

fn non_empty(text: Option<String>) -> Option<String> {
    text.filter(|t| !t.is_empty())
}

impl From<RawRun> for CheckRun {
    fn from(run: RawRun) -> Self {
        let (title, annotations_count) = run
            .output
            .map_or((None, 0), |o| (o.title, o.annotations_count));
        Self {
            id: run.id,
            name: run.name,
            status: run.status,
            conclusion: run.conclusion,
            html_url: run.html_url,
            details_url: run.details_url,
            title,
            annotations_count,
            app: run.app.and_then(|a| a.name),
        }
    }
}

impl Client {
    /// Check runs for a commit; `None` when GitHub does not have the commit.
    pub fn check_runs(&self, repo: &RepoRef, sha: &str) -> Result<Option<Vec<CheckRun>>> {
        let path = format!("{}/commits/{}/check-runs", repo_path(repo), encode(sha));
        let runs = self.paginate(&path, &[], |page: RawRuns| page.check_runs);
        Ok(or_none(runs, &[404, 422])?.map(|runs| runs.into_iter().map(CheckRun::from).collect()))
    }

    pub fn check_run_annotations(
        &self,
        repo: &RepoRef,
        check_run_id: u64,
    ) -> Result<Vec<CheckAnnotation>> {
        let path = format!("{}/check-runs/{check_run_id}/annotations", repo_path(repo));
        self.paginate(&path, &[], |page: Vec<RawAnnotation>| {
            page.into_iter()
                .map(|a| CheckAnnotation {
                    check_run_id,
                    path: a.path,
                    start_line: a.start_line,
                    end_line: a.end_line.unwrap_or(a.start_line),
                    level: a.annotation_level,
                    title: non_empty(a.title),
                    message: a.message,
                    raw_details: non_empty(a.raw_details),
                })
                .collect()
        })
    }

    /// The latest status per context; `None` when GitHub does not have the commit.
    pub fn commit_statuses(&self, repo: &RepoRef, sha: &str) -> Result<Option<Vec<CommitStatus>>> {
        let path = format!("{}/commits/{}/status", repo_path(repo), encode(sha));
        let pages = self.paginate(&path, &[], |page: RawCombined| page.statuses);
        or_none(pages, &[404, 422])
    }
}
