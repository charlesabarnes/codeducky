//! The workspace's pull request and GitHub actions: the inbox, opening pull requests, replies,
//! thread navigation, and the push, submit and settings dialogs.

use std::collections::HashSet;

use ducky_github::review::unpushed_notes;
use ducky_github::{RepoRef, parse_pull_reference};
use ducky_review::Side;
use ducky_review::view_notes::NoteView;
use ducky_session::pull::branch_pull;
use gpui_kit::component::WindowExt as _;
use gpui_kit::component::input::TextareaState;
use gpui_kit::*;

use crate::keymap::*;
use crate::state::cursor::LinePos;
use crate::state::{GitHubEvent, PullEvent, SidebarTab};
use crate::views::pull::push_dialog::PushDialog;
use crate::views::pull::settings::GitHubSettingsDialog;
use crate::views::pull::submit_dialog::{SubmitParts, SubmitReviewDialog};
use crate::views::workspace::{Dialog, Workspace};

impl Workspace {
    pub(crate) fn on_pull_event(
        &mut self,
        event: &PullEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            PullEvent::NotesChanged => self.model.update(cx, |m, cx| m.reload_notes(true, cx)),
            PullEvent::Failed(text) => {
                let text = text.clone();
                self.toast_error(text, window, cx);
            }
        }
    }

    pub(crate) fn on_github_event(
        &mut self,
        event: &GitHubEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            GitHubEvent::SignedIn => {}
            GitHubEvent::Failed(text) => {
                let text = format!("GitHub: {text}");
                self.toast_error(text, window, cx);
            }
        }
    }

    fn toast_error(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        self.last_toast = Some(text.clone());
        window.push_notification(
            gpui_kit::component::notification::Notification::error(text),
            cx,
        );
    }

    /// The pull request follows the review on screen; a branch review looks for its PR.
    pub(crate) fn follow_pull(&mut self, cx: &mut Context<Self>) {
        let review = self.model.read(cx).review.clone();
        self.pull.update(cx, |p, cx| p.follow(review.as_ref(), cx));
        self.reply_input = None;
        self.lookup_branch_pull(cx);
    }

    /// A branch review of a github.com checkout looks for the branch's open pull request.
    fn lookup_branch_pull(&mut self, cx: &mut Context<Self>) {
        let review = self.model.read(cx).review.clone();
        let Some(review) = review.filter(|r| r.pull.is_none() && r.repo().is_some()) else {
            return;
        };
        let setup = self.github.read(cx).setup.clone();
        let (github, pull) = (self.github.downgrade(), self.pull.downgrade());
        cx.spawn(async move |_, cx| {
            let lookup = review.clone();
            let repo = cx
                .background_executor()
                .spawn(async move {
                    let repo = ducky_session::pull::github_repo(lookup.repo()?).ok()?;
                    setup.check_repo(&repo).ok().map(|_| repo)
                })
                .await;
            if repo.is_none() {
                return;
            }
            github
                .update(cx, |g, cx| {
                    g.with_client(cx, move |_, client, cx| {
                        cx.spawn(async move |_, cx| {
                            let found = cx
                                .background_executor()
                                .spawn(async move { branch_pull(&client, &review).ok().flatten() })
                                .await;
                            pull.update(cx, |p, cx| p.set_branch_pull(found, cx)).ok();
                        })
                        .detach();
                    })
                })
                .ok();
        })
        .detach();
    }

    pub fn open_inbox(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.github.update(cx, |g, cx| g.open_inbox(cx));
        window.focus(&self.focus, cx);
        cx.notify();
    }

    pub fn close_inbox(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.github.update(cx, |g, cx| g.close_inbox(cx));
        if self.model.read(cx).review.is_some() {
            window.focus(&self.focus, cx);
        }
        cx.notify();
    }

    pub fn open_pull(
        &mut self,
        repo: RepoRef,
        number: u64,
        from_branch: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Err(reason) = self.github.read(cx).setup.check_repo(&repo) {
            self.model.update(cx, |m, cx| m.fail(reason, cx));
            return;
        }
        let branch = from_branch
            .then(|| self.model.read(cx).review.clone())
            .flatten();
        let model = self.model.downgrade();
        self.github.update(cx, |g, cx| {
            g.inbox_open = false;
            g.with_client(cx, move |_, client, cx| {
                model
                    .update(cx, |m, cx| m.open_pull(client, repo, number, branch, cx))
                    .ok();
            })
        });
        window.focus(&self.focus, cx);
        cx.notify();
    }

    /// Opens what was pasted in the inbox: a pull request URL, `owner/repo#123`, or `#123` for
    /// the repository of the review on screen.
    pub fn open_pr_input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.pr_input.read(cx).value().trim().to_owned();
        let context = self
            .model
            .read(cx)
            .review
            .as_ref()
            .and_then(|r| r.pull.as_ref().map(|p| p.repo.clone()));
        match parse_pull_reference(&text, context.as_ref()) {
            Some(pull) => {
                self.pr_input_error = None;
                self.open_pull(pull.repo, pull.number, false, window, cx);
            }
            None => {
                self.pr_input_error = Some(
                    "Paste a GitHub pull request URL, owner/repo#123, or #123 while one of the \
                     repository's pull requests is open."
                        .into(),
                );
                cx.notify();
            }
        }
    }

    pub fn open_inbox_row(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let github = self.github.read(cx);
        let Some(row) = github.inbox.as_ref().and_then(|inbox| {
            crate::views::inbox::rows(inbox)
                .get(github.inbox_cursor)
                .map(|row| (RepoRef::new(&row.owner, &row.name), row.number))
        }) else {
            return;
        };
        self.open_pull(row.0, row.1, false, window, cx);
    }

    pub fn move_inbox(&mut self, delta: isize, cx: &mut Context<Self>) {
        self.github.update(cx, |g, cx| {
            let count = g
                .inbox
                .as_ref()
                .map_or(0, |inbox| crate::views::inbox::rows(inbox).len());
            if count > 0 {
                g.inbox_cursor = g.inbox_cursor.saturating_add_signed(delta).min(count - 1);
            }
            cx.notify();
        });
    }

    pub fn open_branch_pull(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match self.pull.read(cx).branch_pull.clone() {
            Some((repo, pr)) => self.open_pull(repo, pr.number, true, window, cx),
            None => self.model.update(cx, |m, cx| {
                m.say("no open pull request found for this branch", cx)
            }),
        }
    }

    pub fn open_github_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let github = self.github.clone();
        let dialog = cx.new(|cx| GitHubSettingsDialog::new(github, window, cx));
        self.dialog = Some(Dialog::GitHubSettings(dialog));
        cx.notify();
    }

    pub fn open_push_dialog(&mut self, cx: &mut Context<Self>) {
        let model = self.model.read(cx);
        let Some(review) = model.review.as_ref() else {
            return;
        };
        let Some(preview) = ducky_session::pull::push_preview(review) else {
            self.model.update(cx, |m, cx| {
                m.say(
                    "push notes works on a pull request review: open the branch's PR (g o)",
                    cx,
                )
            });
            return;
        };
        let pull = self.pull.read(cx);
        let (pending, writes_off) = (pull.pending().cloned(), pull.writes_refused());
        let pull = self.pull.clone();
        let dialog = cx.new(|_| PushDialog::new(pull, preview, pending, writes_off));
        self.dialog = Some(Dialog::PushNotes(dialog));
        cx.notify();
    }

    pub fn open_submit_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let model = self.model.read(cx);
        let Some((review, context)) = model
            .review
            .as_ref()
            .and_then(|r| Some((r, r.pull.as_ref()?)))
        else {
            self.model.update(cx, |m, cx| {
                m.say("submit works on a pull request review", cx)
            });
            return;
        };
        let pull = self.pull.read(cx);
        let viewer = pull.activity.as_ref().map(|a| a.threads.viewer.clone());
        let notes = review.notes.clone();
        let placement = ducky_github::placement::place_notes(
            &unpushed_notes(&notes),
            &context.snapshot.files,
            &Default::default(),
        );
        let parts = SubmitParts {
            number: context.number(),
            title: context.pr().title.clone(),
            own_pull: viewer.as_deref() == Some(context.snapshot.pull.author.as_str()),
            notes,
            placement,
            pending: pull.pending().cloned(),
            required_open: model.checklists.progress(&review.state).required_open,
            writes_off: pull.writes_refused(),
        };
        let pull = self.pull.clone();
        let dialog = cx.new(|cx| SubmitReviewDialog::new(pull, parts, window, cx));
        self.dialog = Some(Dialog::SubmitReview(dialog));
        cx.notify();
    }

    pub fn start_reply(&mut self, thread: String, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(reason) = self.pull.read(cx).writes_refused() {
            self.model.update(cx, |m, cx| m.fail(reason.into(), cx));
            return;
        }
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(3, 12)
                .placeholder("Reply on GitHub (Markdown)")
        });
        input.update(cx, |input, cx| input.focus(window, cx));
        self.reply_input = Some(input);
        self.pull.update(cx, |p, cx| {
            p.thread_focus = Some(thread.clone());
            p.start_reply(Some(thread), cx)
        });
    }

    pub fn send_reply(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(input), Some(thread)) = (
            self.reply_input.clone(),
            self.pull.read(cx).replying.clone(),
        ) else {
            return;
        };
        let body = input.read(cx).value().to_string();
        self.pull.update(cx, |p, cx| p.reply(thread, body, cx));
        window.focus(&self.focus, cx);
    }

    pub fn cancel_reply(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.reply_input = None;
        self.pull.update(cx, |p, cx| p.start_reply(None, cx));
        window.focus(&self.focus, cx);
    }

    /// Shows a thread: selects its file and scrolls to its line in All changes.
    pub fn focus_thread(&mut self, id: String, _: &mut Window, cx: &mut Context<Self>) {
        let Some(thread) = self
            .pull
            .read(cx)
            .threads()
            .iter()
            .find(|t| t.id == id)
            .cloned()
        else {
            return;
        };
        self.pull.update(cx, |p, cx| {
            p.thread_focus = Some(id);
            cx.notify();
        });
        self.show_thread_line(&thread.path, thread.line.map(|l| (thread.side, l)), cx);
    }

    fn show_thread_line(&mut self, path: &str, at: Option<(Side, u32)>, cx: &mut Context<Self>) {
        self.model.update(cx, |m, cx| {
            if m.note_view() != NoteView::All {
                m.set_review_mode(ducky_session::ReviewMode::All, cx);
            }
            if let Some((side, line)) = at {
                m.cursor = Some(LinePos { side, line });
            }
            if m.selected.as_deref() == Some(path) {
                if let Some(at) = m.cursor {
                    cx.emit(crate::state::ModelEvent::ScrollTo(at));
                }
            } else {
                m.select(path.to_owned(), cx);
            }
            cx.notify();
        });
    }

    pub fn step_thread(&mut self, forward: bool, cx: &mut Context<Self>) {
        let paths: Vec<String> = {
            let model = self.model.read(cx);
            model
                .ordered()
                .into_iter()
                .map(|i| model.visible[i].path().to_owned())
                .collect()
        };
        let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
        let thread = self.pull.update(cx, |p, cx| {
            let found = p.step_thread(forward, &refs);
            cx.notify();
            found
        });
        match thread {
            Some(thread) => {
                self.show_thread_line(&thread.path, thread.line.map(|l| (thread.side, l)), cx)
            }
            None => self
                .model
                .update(cx, |m, cx| m.say("no review threads", cx)),
        }
    }

    pub(crate) fn bind_pull_actions(
        &self,
        root: Stateful<Div>,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        root.on_action(cx.listener(|this, _: &OpenInbox, window, cx| this.open_inbox(window, cx)))
            .on_action(cx.listener(|this, _: &CloseInbox, window, cx| this.close_inbox(window, cx)))
            .on_action(cx.listener(|this, _: &InboxNext, _, cx| this.move_inbox(1, cx)))
            .on_action(cx.listener(|this, _: &InboxPrev, _, cx| this.move_inbox(-1, cx)))
            .on_action(
                cx.listener(|this, _: &InboxOpen, window, cx| this.open_inbox_row(window, cx)),
            )
            .on_action(cx.listener(|this, _: &InboxFocusInput, window, cx| {
                this.pr_input
                    .update(cx, |input, cx| input.focus(window, cx))
            }))
            .on_action(cx.listener(|this, _: &RefreshInbox, _, cx| {
                this.github.update(cx, |g, cx| g.refresh_inbox(cx))
            }))
            .on_action(cx.listener(|this, _: &GitHubSettings, window, cx| {
                this.open_github_settings(window, cx)
            }))
            .on_action(
                cx.listener(|this, _: &OpenBranchPull, window, cx| {
                    this.open_branch_pull(window, cx)
                }),
            )
            .on_action(cx.listener(|this, _: &PushNotes, _, cx| this.open_push_dialog(cx)))
            .on_action(
                cx.listener(|this, _: &SubmitReview, window, cx| {
                    this.open_submit_dialog(window, cx)
                }),
            )
            .on_action(cx.listener(|this, _: &NextThread, _, cx| this.step_thread(true, cx)))
            .on_action(cx.listener(|this, _: &PrevThread, _, cx| this.step_thread(false, cx)))
            .on_action(cx.listener(|this, _: &ReplyThread, window, cx| {
                if let Some(id) = this.pull.read(cx).focused_thread().map(|t| t.id.clone()) {
                    this.start_reply(id, window, cx);
                }
            }))
            .on_action(cx.listener(|this, _: &ResolveThread, _, cx| {
                if let Some(id) = this.pull.read(cx).focused_thread().map(|t| t.id.clone()) {
                    this.pull.update(cx, |p, cx| p.toggle_resolved(id, cx));
                }
            }))
            .on_action(
                cx.listener(|this, _: &ThreadsTab, _, cx| this.set_tab(SidebarTab::Threads, cx)),
            )
            .on_action(cx.listener(|this, _: &CiTab, _, cx| this.set_tab(SidebarTab::Ci, cx)))
    }

    pub fn set_tab(&mut self, tab: SidebarTab, cx: &mut Context<Self>) {
        self.model.update(cx, |m, cx| {
            m.tab = tab;
            cx.notify();
        });
    }

    /// Paths of the review's files, for grouping CI annotations.
    pub fn review_paths(&self, cx: &App) -> HashSet<String> {
        self.model
            .read(cx)
            .review
            .as_ref()
            .map(|r| r.files.iter().map(|f| f.path().to_owned()).collect())
            .unwrap_or_default()
    }
}
