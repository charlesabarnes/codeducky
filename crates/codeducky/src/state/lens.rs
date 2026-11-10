//! Which part of the review is on screen: all changes, since your last look, or commits.

use ducky_review::commit_range::{CommitRange, Step, step_commit};
use ducky_review::last_look::SinceKind;
use ducky_session::{ChangedFile, ReviewMode, ReviewView, SessionError, ViewEntry};
use gpui_kit::*;

use super::model::{ReviewModel, Work};
use crate::config::SavedMode;

impl ReviewModel {
    /// The files the sidebar lists: the view's, without unchanged ones in since mode unless shown.
    pub(super) fn relist(&mut self) {
        let show_unchanged = self.show_unchanged;
        self.visible = self
            .view
            .as_ref()
            .map(|view| {
                view.entries
                    .iter()
                    .filter(|e| show_unchanged || e.since != Some(SinceKind::Unchanged))
                    .map(|e| e.file.clone())
                    .collect()
            })
            .unwrap_or_default();
    }

    pub fn entry(&self, path: &str) -> Option<&ViewEntry> {
        self.view.as_ref()?.entry(path)
    }

    pub fn current_entry(&self) -> Option<&ViewEntry> {
        self.entry(self.selected.as_deref()?)
    }

    /// The branch's own change for a path, which viewed marks are kept against.
    pub fn final_file(&self, path: &str) -> Option<&ChangedFile> {
        self.review
            .as_ref()?
            .files
            .iter()
            .find(|f| f.path() == path)
    }

    pub fn is_viewed(&self, path: &str) -> bool {
        match (self.review.as_ref(), self.final_file(path)) {
            (Some(review), Some(file)) => review.is_viewed(file),
            _ => false,
        }
    }

    pub fn commit_range(&self) -> Option<CommitRange> {
        let ReviewMode::Commits { from, to } = &self.mode else {
            return None;
        };
        CommitRange::find(&self.review.as_ref()?.commits, from, to)
    }

    fn unsaved_blocks(&mut self, cx: &mut Context<Self>) -> bool {
        match self.unsaved.clone() {
            Some(path) => {
                self.fail(
                    format!("{path} has unsaved changes: save them (cmd-s) or revert them first"),
                    cx,
                );
                true
            }
            None => false,
        }
    }

    pub fn set_review_mode(&mut self, mode: ReviewMode, cx: &mut Context<Self>) {
        if self.unsaved_blocks(cx) {
            return;
        }
        if mode == ReviewMode::Since && self.review.as_ref().is_some_and(|r| r.since.is_none()) {
            self.say(
                "no last look yet: mark files viewed (v) or the review reviewed (V) first",
                cx,
            );
            return;
        }
        let saved = match &mode {
            ReviewMode::All => Some(SavedMode::All),
            ReviewMode::Since => Some(SavedMode::Since),
            ReviewMode::Commits { .. } => None,
        };
        if let (Some(saved), Some(review)) = (saved, self.review.as_ref()) {
            let key = crate::config::repo_key(review.machine(), review.toplevel());
            self.prefs.set_mode(key, saved);
            self.save_prefs();
        }
        self.mode = mode;
        self.rebuild_view(cx);
    }

    pub fn toggle_since(&mut self, cx: &mut Context<Self>) {
        let next = if self.mode == ReviewMode::Since {
            ReviewMode::All
        } else {
            ReviewMode::Since
        };
        self.set_review_mode(next, cx);
    }

    /// Reads the view for the current mode, then shows the selected file in it (or the first).
    pub(super) fn rebuild_view(&mut self, cx: &mut Context<Self>) {
        let Some(review) = self.review.clone() else {
            return;
        };
        let mode = self.mode.clone();
        let work: Work<Result<ReviewView, String>> = Box::new(move || match review.view(&mode) {
            Ok(view) => Ok(Ok(view)),
            Err(SessionError::CommitsGone) => Ok(Err(SessionError::CommitsGone.to_string())),
            Err(error) => Err(error.to_string()),
        });
        self.run("loading the view", cx, work, |this, view, cx| match view {
            Ok(view) => this.show_view(view, cx),
            Err(gone) => {
                this.fail(gone, cx);
                this.mode = ReviewMode::All;
                this.rebuild_view(cx);
            }
        });
    }

    fn show_view(&mut self, view: ReviewView, cx: &mut Context<Self>) {
        self.view = Some(view);
        self.relist();
        let keep = self
            .selected
            .clone()
            .filter(|path| self.visible.iter().any(|f| f.path() == path));
        match keep.or_else(|| self.first_file()) {
            Some(path) => self.load_diff(path, cx),
            None => {
                self.selected = None;
                self.diff = None;
                cx.emit(super::ModelEvent::DiffReady);
            }
        }
        cx.notify();
    }

    pub fn toggle_unchanged(&mut self, cx: &mut Context<Self>) {
        self.show_unchanged = !self.show_unchanged;
        self.relist();
        cx.notify();
    }

    pub fn pick_commit(&mut self, index: usize, extend: bool, cx: &mut Context<Self>) {
        let Some(review) = self.review.as_ref() else {
            return;
        };
        let range = if extend {
            CommitRange::extend(self.commit_range(), index)
        } else {
            CommitRange::single(index)
        };
        let Some(mode) = ReviewMode::commits(range, &review.commits) else {
            return;
        };
        if !extend {
            self.show_commit_picker = false;
        }
        self.set_review_mode(mode, cx);
    }

    /// `}` / `{`: from All changes to the first (or last) commit, past either end back to All.
    pub fn step_commit(&mut self, step: Step, cx: &mut Context<Self>) {
        let Some(review) = self.review.as_ref() else {
            return;
        };
        let count = review.commits.len();
        if count == 0 {
            self.say("no commits on this branch yet", cx);
            return;
        }
        let next = step_commit(self.commit_range(), count, step);
        let message = match next {
            Some(range) => format!(
                "commit {} of {count}: {}",
                range.from + 1,
                range.describe(&review.commits)
            ),
            None => "all changes".to_owned(),
        };
        let mode = next
            .and_then(|range| ReviewMode::commits(range, &review.commits))
            .unwrap_or(ReviewMode::All);
        self.set_review_mode(mode, cx);
        self.say(message, cx);
    }

    /// Records every file as reviewed at this head; the next "since last look" starts here.
    pub fn mark_reviewed(&mut self, cx: &mut Context<Self>) {
        let Some(review) = self.review.as_ref() else {
            return;
        };
        let service = review.notes_service().clone();
        let files = review.files.clone();
        self.run(
            "marking reviewed",
            cx,
            Box::new(move || service.mark_reviewed(&files).map_err(|e| e.to_string())),
            |this, _, cx| {
                this.say("marked reviewed: since last look starts here", cx);
                this.refresh(cx);
            },
        );
    }

    /// The mode a newly opened review starts in: since last look when remembered and possible.
    pub(super) fn initial_mode(&self) -> ReviewMode {
        let Some(review) = self.review.as_ref() else {
            return ReviewMode::All;
        };
        let key = crate::config::repo_key(review.machine(), review.toplevel());
        match self.prefs.mode_for(&key) {
            SavedMode::Since if review.since.is_some() => ReviewMode::Since,
            _ => ReviewMode::All,
        }
    }
}
