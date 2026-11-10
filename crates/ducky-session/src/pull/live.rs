//! What changes on GitHub while a pull request is open: threads, reviewers, CI and its head.

use std::collections::HashSet;
use std::thread;

use ducky_github::ci::{
    CiSnapshot, FileForAnnotations, PlacedAnnotations, fetch_ci, group_annotations,
    place_annotations,
};
use ducky_github::reviewers::{Reviewer, reviewer_states};
use ducky_github::threads::{
    PlacedThreads, PullThreads, ReviewThread, ThreadComment, fetch_threads, place_threads,
};
use ducky_github::{GitHubError, threads};

use super::PullContext;
use crate::error::Result;

/// The pull request's conversation as last read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullActivity {
    pub threads: PullThreads,
    pub reviewers: Vec<Reviewer>,
}

/// Threads and reviews, read side by side.
pub fn load_activity(pull: &PullContext) -> Result<PullActivity> {
    let (threads, reviews) = thread::scope(|scope| {
        let reviews = scope.spawn(|| pull.client.pull_reviews(&pull.repo, pull.number()));
        let threads = fetch_threads(&pull.client, &pull.repo, pull.number());
        let reviews = reviews
            .join()
            .unwrap_or_else(|_| Err(panicked("the reviews")));
        (threads, reviews)
    });
    Ok(PullActivity {
        threads: threads?,
        reviewers: reviewer_states(&pull.snapshot.pull, &reviews?),
    })
}

fn panicked(what: &str) -> GitHubError {
    GitHubError::new(
        ducky_github::ErrorKind::Network,
        0,
        format!("reading {what} failed"),
    )
}

/// CI for the pull request's head as loaded; `None` when GitHub does not have the commit.
pub fn load_ci(pull: &PullContext) -> Result<Option<CiSnapshot>> {
    Ok(fetch_ci(&pull.client, &pull.repo, pull.head_sha())?)
}

/// The pull request's head on GitHub now, to tell whether it moved since it was loaded.
pub fn current_head(pull: &PullContext) -> Result<String> {
    Ok(pull.client.pull(&pull.repo, pull.number())?.pr.head_sha)
}

/// One file's threads: on lines of the diff, and the rest (outdated, on the file).
pub fn file_threads(all: &[ReviewThread], path: &str) -> PlacedThreads {
    let mine: Vec<ReviewThread> = all.iter().filter(|t| t.path == path).cloned().collect();
    place_threads(&mine)
}

/// One file's annotations on the new side. `new_line_count` is `None` without text there.
pub fn file_annotations(
    ci: &CiSnapshot,
    paths: &HashSet<&str>,
    path: &str,
    new_line_count: Option<u32>,
) -> PlacedAnnotations {
    let grouped = group_annotations(&ci.annotations, paths);
    let annotations = grouped.by_path.get(path).cloned().unwrap_or_default();
    place_annotations(
        &annotations,
        FileForAnnotations {
            new_line_count,
            matches_checked_commit: true,
        },
    )
}

/// Posts a reply right away (not part of a pending review).
pub fn reply_to_thread(pull: &PullContext, thread_id: &str, body: &str) -> Result<ThreadComment> {
    Ok(threads::reply_to_thread(&pull.client, thread_id, body)?)
}

pub fn set_thread_resolved(pull: &PullContext, thread_id: &str, resolved: bool) -> Result<bool> {
    Ok(threads::set_thread_resolved(
        &pull.client,
        thread_id,
        resolved,
    )?)
}
