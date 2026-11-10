//! What the open pull request has on GitHub besides its diff: threads, reviewers, your pending
//! review, CI (polled while checks run and the window is active) and whether its head moved.
//! Also the pull request of a branch under review, for the "this branch has PR #n" chip.

use std::time::{Duration, Instant};

use ducky_github::ci::{CiSnapshot, CiState, poll_delay};
use ducky_github::review::{PushResult, PushSelection, SubmitInput, SubmitResult};
use ducky_github::threads::{PendingReview, ReviewThread, order_threads};
use ducky_github::{PullRequest, RepoRef};
use ducky_session::Review;
use ducky_session::pull::{
    PullActivity, PullContext, current_head, load_activity, load_ci, push_notes, reply_to_thread,
    set_thread_resolved, submit_review,
};
use gpui_kit::*;

const HEAD_CHECK_EVERY: Duration = Duration::from_secs(30);

pub enum PullEvent {
    /// Notes were linked to GitHub comments: reload them.
    NotesChanged,
    Failed(String),
}

impl EventEmitter<PullEvent> for PullModel {}

#[derive(Default)]
pub struct PullModel {
    pub review: Option<Review>,
    pub activity: Option<PullActivity>,
    pub activity_error: Option<String>,
    pub ci: Option<CiSnapshot>,
    pub ci_error: Option<String>,
    /// The head GitHub has now, when it is not the one loaded.
    pub moved_to: Option<String>,
    /// The open pull request of the branch under review.
    pub branch_pull: Option<(RepoRef, PullRequest)>,
    /// The thread whose reply box is open.
    pub replying: Option<String>,
    /// The thread `t` / `T` last moved to.
    pub thread_focus: Option<String>,
    pub busy: Option<String>,
    generation: u64,
    ci_attempt: u32,
    polling: bool,
    active: bool,
    last_head_check: Option<Instant>,
}

impl PullModel {
    pub fn new() -> Self {
        Self {
            active: true,
            ..Self::default()
        }
    }

    pub fn context(&self) -> Option<&PullContext> {
        self.review.as_ref()?.pull.as_ref()
    }

    pub fn pending(&self) -> Option<&PendingReview> {
        self.activity.as_ref()?.threads.pending_review.as_ref()
    }

    pub fn threads(&self) -> &[ReviewThread] {
        self.activity
            .as_ref()
            .map_or(&[], |a| a.threads.threads.as_slice())
    }

    pub fn ci_pending(&self) -> bool {
        self.ci
            .as_ref()
            .is_some_and(|ci| ci.summary().state == CiState::Pending)
    }

    /// Why writes are off in this run, if they are.
    pub fn writes_refused(&self) -> Option<&'static str> {
        self.context()
            .filter(|p| p.client.is_read_only())
            .map(|_| "read-only run: writes to GitHub are off")
    }

    /// Points at the review now on screen; loads its pull request's activity and CI.
    pub fn follow(&mut self, review: Option<&Review>, cx: &mut Context<Self>) {
        let same = match (&self.review, review) {
            (Some(a), Some(b)) => a.toplevel() == b.toplevel() && a.target == b.target,
            _ => false,
        };
        self.generation += 1;
        self.review = review.cloned();
        self.moved_to = None;
        self.polling = false;
        self.ci_attempt = 0;
        if !same {
            self.activity = None;
            self.ci = None;
            self.replying = None;
            self.thread_focus = None;
            self.branch_pull = None;
        }
        self.activity_error = None;
        self.ci_error = None;
        if self.context().is_some() {
            self.branch_pull = None;
            self.load_activity(cx);
            self.load_ci(cx);
        }
        cx.notify();
    }

    pub fn set_branch_pull(
        &mut self,
        found: Option<(RepoRef, PullRequest)>,
        cx: &mut Context<Self>,
    ) {
        self.branch_pull = found;
        cx.notify();
    }

    fn spawn<T: Send + 'static>(
        &mut self,
        cx: &mut Context<Self>,
        work: impl FnOnce(PullContext) -> ducky_session::Result<T> + Send + 'static,
        done: impl FnOnce(&mut Self, Result<T, String>, &mut Context<Self>) + 'static,
    ) {
        let Some(context) = self.context().cloned() else {
            return;
        };
        let generation = self.generation;
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { work(context).map_err(|e| e.to_string()) })
                .await;
            this.update(cx, |this, cx| {
                if this.generation == generation {
                    done(this, result, cx);
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    pub fn load_activity(&mut self, cx: &mut Context<Self>) {
        self.spawn(
            cx,
            |pull| load_activity(&pull),
            |this, result, _| match result {
                Ok(activity) => {
                    this.activity = Some(activity);
                    this.activity_error = None;
                }
                Err(error) => this.activity_error = Some(error),
            },
        );
    }

    pub fn load_ci(&mut self, cx: &mut Context<Self>) {
        self.spawn(
            cx,
            |pull| load_ci(&pull),
            |this, result, cx| {
                match result {
                    Ok(ci) => {
                        this.ci = ci;
                        this.ci_error = None;
                    }
                    Err(error) => this.ci_error = Some(error),
                }
                this.schedule_poll(cx);
            },
        );
    }

    /// While checks are pending and the window is active: 10 s, 20 s, 40 s, then every minute.
    fn schedule_poll(&mut self, cx: &mut Context<Self>) {
        if self.polling || !self.active || !self.ci_pending() {
            return;
        }
        self.polling = true;
        let delay = poll_delay(self.ci_attempt);
        let generation = self.generation;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            this.update(cx, |this, cx| {
                if this.generation != generation || !this.polling {
                    return;
                }
                this.polling = false;
                if this.active {
                    this.ci_attempt += 1;
                    this.load_ci(cx);
                    this.check_head(false, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    /// Polling only runs while the window is active.
    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        self.active = active;
        if !active {
            self.polling = false;
            return;
        }
        self.check_head(false, cx);
        self.schedule_poll(cx);
    }

    /// Asks GitHub for the pull request's head; at most every 30 s unless `force`.
    pub fn check_head(&mut self, force: bool, cx: &mut Context<Self>) {
        let recent = self
            .last_head_check
            .is_some_and(|at| at.elapsed() < HEAD_CHECK_EVERY);
        if self.context().is_none() || (recent && !force) {
            return;
        }
        self.last_head_check = Some(Instant::now());
        self.spawn(
            cx,
            |pull| Ok((current_head(&pull)?, pull.head_sha().to_owned())),
            |this, result, _| {
                if let Ok((now, loaded)) = result {
                    this.moved_to = (now != loaded).then_some(now);
                }
            },
        );
    }

    pub fn start_reply(&mut self, thread: Option<String>, cx: &mut Context<Self>) {
        self.replying = thread;
        cx.notify();
    }

    pub fn reply(&mut self, thread: String, body: String, cx: &mut Context<Self>) {
        if body.trim().is_empty() {
            cx.emit(PullEvent::Failed("a reply needs some text".into()));
            return;
        }
        self.busy = Some("replying".into());
        self.spawn(
            cx,
            move |pull| reply_to_thread(&pull, &thread, body.trim()),
            |this, result, cx| {
                this.busy = None;
                match result {
                    Ok(_) => {
                        this.replying = None;
                        this.load_activity(cx);
                    }
                    Err(error) => cx.emit(PullEvent::Failed(error)),
                }
            },
        );
    }

    pub fn toggle_resolved(&mut self, thread: String, cx: &mut Context<Self>) {
        let Some(resolved) = self
            .threads()
            .iter()
            .find(|t| t.id == thread)
            .map(|t| t.is_resolved)
        else {
            return;
        };
        self.busy = Some(if resolved { "unresolving" } else { "resolving" }.into());
        self.spawn(
            cx,
            move |pull| set_thread_resolved(&pull, &thread, !resolved),
            |this, result, cx| {
                this.busy = None;
                match result {
                    Ok(_) => this.load_activity(cx),
                    Err(error) => cx.emit(PullEvent::Failed(error)),
                }
            },
        );
    }

    pub fn push(
        &mut self,
        selection: PushSelection,
        cx: &mut Context<Self>,
        done: impl FnOnce(Result<PushResult, String>, &mut App) + 'static,
    ) {
        let (Some(review), pending) = (self.review.clone(), self.pending().cloned()) else {
            return;
        };
        self.busy = Some("pushing notes".into());
        self.spawn(
            cx,
            move |_| push_notes(&review, pending.as_ref(), &selection),
            |this, result, cx| {
                this.busy = None;
                if result.is_ok() {
                    this.load_activity(cx);
                    cx.emit(PullEvent::NotesChanged);
                }
                done(result, cx);
            },
        );
    }

    pub fn submit(
        &mut self,
        input: SubmitInput,
        cx: &mut Context<Self>,
        done: impl FnOnce(Result<SubmitResult, String>, &mut App) + 'static,
    ) {
        let (Some(review), pending) = (self.review.clone(), self.pending().cloned()) else {
            return;
        };
        self.busy = Some("submitting".into());
        self.spawn(
            cx,
            move |_| submit_review(&review, pending.as_ref(), &input),
            |this, result, cx| {
                this.busy = None;
                if result.is_ok() {
                    this.load_activity(cx);
                    cx.emit(PullEvent::NotesChanged);
                }
                done(result, cx);
            },
        );
    }

    /// The next (or previous) thread in reading order over `paths`; it becomes the focus.
    pub fn step_thread(&mut self, forward: bool, paths: &[&str]) -> Option<ReviewThread> {
        let ordered = order_threads(self.threads(), paths);
        if ordered.is_empty() {
            return None;
        }
        let at = self
            .thread_focus
            .as_ref()
            .and_then(|id| ordered.iter().position(|t| &t.id == id));
        let next = match (at, forward) {
            (None, true) => 0,
            (None, false) => ordered.len() - 1,
            (Some(i), true) => (i + 1).min(ordered.len() - 1),
            (Some(i), false) => i.saturating_sub(1),
        };
        let thread = ordered[next].clone();
        self.thread_focus = Some(thread.id.clone());
        Some(thread)
    }

    pub fn focused_thread(&self) -> Option<&ReviewThread> {
        let id = self.thread_focus.as_ref()?;
        self.threads().iter().find(|t| &t.id == id)
    }
}
