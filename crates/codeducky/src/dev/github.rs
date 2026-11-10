//! Dev scripting for GitHub. `--fake-github` starts an in-process fake GitHub (pull request #7 on
//! acme/widgets) and points the app at it; `--github-base-url` points it at another fake. Without
//! either, a scripted run reads the real API read-only and only charlesabarnes/codeducky, and
//! every step that would write to GitHub is refused.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use ducky_github::fake::{Auth, FakeWorld, WorldOptions};
use ducky_github::{RepoRef, ReviewEvent, parse_pull_reference};
use ducky_review::{NumberedLine, Severity, Side, number_lines};
use ducky_session::{DiffOptions, NoteDraft};
use gpui_kit::*;

use super::script::fail;
use crate::state::github::GitHubSetup;
use crate::state::{GitHubModel, PullModel, ReviewModel};
use crate::views::workspace::{Dialog, Workspace};

const TIMEOUT: Duration = Duration::from_secs(60);
const REAL_REPO: (&str, &str) = ("charlesabarnes", "codeducky");

static WORLD: OnceLock<FakeWorld> = OnceLock::new();

#[derive(Debug, Default)]
pub struct GitHubSteps {
    fake: bool,
    base_url: Option<String>,
    auth: Option<Auth>,
    inbox: bool,
    inbox_cursor: Option<usize>,
    open_pr: Option<String>,
    open_branch_pr: bool,
    pr_notes: Vec<(String, u32, String)>,
    focus_thread: Option<String>,
    reply_thread: Option<String>,
    reply_text: Option<String>,
    send_reply: bool,
    resolve_thread: Option<String>,
    push_dialog: bool,
    push: bool,
    submit_dialog: bool,
    submit_event: Option<ReviewEvent>,
    submit_body: Option<String>,
    submit_review: bool,
    head_move: bool,
    settings: bool,
    paste_token: Option<String>,
    any: bool,
}

impl GitHubSteps {
    pub fn parse(&mut self, flag: &str, value: &mut dyn FnMut() -> String) -> bool {
        match flag {
            "--fake-github" => self.fake = true,
            "--github-base-url" => self.base_url = Some(value()),
            "--fake-auth" => {
                self.auth = Some(match value().as_str() {
                    "signed-out" => Auth::SignedOut,
                    "missing-scopes" => Auth::MissingScopes,
                    "ok" => Auth::SignedIn,
                    other => fail(format!(
                        "--fake-auth: ok, signed-out or missing-scopes: {other}"
                    )),
                })
            }
            "--inbox" => self.inbox = true,
            "--inbox-cursor" => {
                let v = value();
                self.inbox_cursor = Some(
                    v.parse()
                        .unwrap_or_else(|_| fail(format!("--inbox-cursor {v}"))),
                );
            }
            "--open-pr" => self.open_pr = Some(value()),
            "--open-branch-pr" => self.open_branch_pr = true,
            "--pr-note" => {
                let v = value();
                let mut parts = v.splitn(3, ':');
                let (Some(path), Some(line), Some(text)) =
                    (parts.next(), parts.next(), parts.next())
                else {
                    fail(format!("--pr-note wants <path>:<line>:<text>: {v}"))
                };
                let line = line
                    .parse()
                    .unwrap_or_else(|_| fail(format!("--pr-note line: {line}")));
                self.pr_notes.push((path.into(), line, text.into()));
            }
            "--focus-thread" => self.focus_thread = Some(value()),
            "--reply-thread" => self.reply_thread = Some(value()),
            "--reply-text" => self.reply_text = Some(value()),
            "--send-reply" => self.send_reply = true,
            "--resolve-thread" => self.resolve_thread = Some(value()),
            "--push-dialog" => self.push_dialog = true,
            "--push" => self.push = true,
            "--submit-dialog" => self.submit_dialog = true,
            "--submit-event" => {
                self.submit_event = Some(match value().as_str() {
                    "comment" => ReviewEvent::Comment,
                    "approve" => ReviewEvent::Approve,
                    "request-changes" => ReviewEvent::RequestChanges,
                    other => fail(format!(
                        "--submit-event: comment, approve or request-changes: {other}"
                    )),
                })
            }
            "--submit-body" => self.submit_body = Some(value()),
            "--submit-review" => self.submit_review = true,
            "--head-move" => self.head_move = true,
            "--github-settings" => self.settings = true,
            "--paste-token" => self.paste_token = Some(value()),
            _ => return false,
        }
        self.any = true;
        true
    }

    fn writes(&self) -> bool {
        self.send_reply || self.resolve_thread.is_some() || self.push || self.submit_review
    }

    /// The GitHub this run talks to; starts the fake world when asked for.
    pub fn setup(&self, scripted: bool) -> GitHubSetup {
        if self.fake {
            let world = WORLD.get_or_init(|| {
                FakeWorld::start(WorldOptions {
                    auth: self.auth.unwrap_or(Auth::SignedIn),
                    ..WorldOptions::default()
                })
            });
            eprintln!("fake GitHub at {}", world.url());
            return GitHubSetup::fake(world.url().to_owned());
        }
        if let Some(url) = &self.base_url {
            return GitHubSetup::fake(url.clone());
        }
        if self.writes() || self.head_move || self.auth.is_some() {
            fail(
                "writes to GitHub, --head-move and --fake-auth need --fake-github or \
                 --github-base-url (never the real API)"
                    .into(),
            );
        }
        if scripted {
            GitHubSetup::dev_real(RepoRef::new(REAL_REPO.0, REAL_REPO.1))
        } else {
            GitHubSetup::real()
        }
    }

    /// Opens the inbox or a pull request, and adds notes to it, before the view steps run.
    pub async fn before_view(
        &self,
        window: AnyWindowHandle,
        workspace: &Entity<Workspace>,
        model: &Entity<ReviewModel>,
        cx: &mut AsyncApp,
    ) {
        let (github, pull) = cx.update(|cx| {
            let ws = workspace.read(cx);
            (ws.github.clone(), ws.pull.clone())
        });
        let ui =
            |cx: &mut AsyncApp,
             f: &dyn Fn(&mut Workspace, &mut Window, &mut Context<Workspace>)| {
                window
                    .update(cx, |_, window, cx| {
                        workspace.update(cx, |ws, cx| f(ws, window, cx))
                    })
                    .ok();
            };
        if let Some(reference) = &self.open_pr {
            let pull_ref = parse_pull_reference(reference, None)
                .unwrap_or_else(|| fail(format!("--open-pr: not a pull request: {reference}")));
            let started = Instant::now();
            ui(cx, &|ws, window, cx| {
                ws.open_pull(pull_ref.repo.clone(), pull_ref.number, false, window, cx)
            });
            wait_for_pull(cx, model, &pull, &github).await;
            eprintln!("opened {reference} in {:?}", started.elapsed());
        }
        if self.open_branch_pr {
            wait(cx, "the branch's pull request", |cx| {
                pull.read(cx).branch_pull.is_some()
            })
            .await;
            ui(cx, &|ws, window, cx| ws.open_branch_pull(window, cx));
            wait(cx, "opening the pull request", |cx| {
                model
                    .read(cx)
                    .review
                    .as_ref()
                    .is_some_and(|r| r.pull.is_some())
            })
            .await;
            wait_for_pull(cx, model, &pull, &github).await;
        }
        if !self.pr_notes.is_empty() {
            self.add_notes(model, cx).await;
        }
        if self.inbox {
            ui(cx, &|ws, window, cx| ws.open_inbox(window, cx));
            wait(cx, "the inbox", |cx| {
                let g = github.read(cx);
                !g.is_busy() && (g.inbox.is_some() || g.inbox_error.is_some())
            })
            .await;
            if let Some(at) = self.inbox_cursor {
                cx.update(|cx| github.update(cx, |g, _| g.inbox_cursor = at));
            }
        }
    }

    async fn add_notes(&self, model: &Entity<ReviewModel>, cx: &mut AsyncApp) {
        let review = cx
            .update(|cx| model.read(cx).review.clone())
            .unwrap_or_else(|| fail("--pr-note needs an open review".into()));
        let notes = self.pr_notes.clone();
        let result = cx
            .background_executor()
            .spawn(async move {
                for (path, line, text) in notes {
                    let diff = review
                        .load_diff(&path, DiffOptions::default())
                        .map_err(|e| e.to_string())?;
                    let lines: Vec<NumberedLine> = diff
                        .side_lines(Side::New)
                        .map(<[NumberedLine]>::to_vec)
                        .unwrap_or_else(|| number_lines(""));
                    let draft = NoteDraft {
                        path,
                        side: Side::New,
                        line,
                        end_line: None,
                        body: text,
                        severity: Severity::Issue,
                    };
                    review
                        .notes_service()
                        .add(draft, &lines)
                        .map_err(|e| e.to_string())?;
                }
                Ok::<_, String>(())
            })
            .await;
        if let Err(error) = result {
            fail(format!("--pr-note: {error}"));
        }
        cx.update(|cx| model.update(cx, |m, cx| m.reload_notes(true, cx)));
        wait(cx, "the notes", |cx| model.read(cx).is_ready()).await;
    }

    /// Threads, dialogs and writes, after the view steps.
    pub async fn after_view(
        &self,
        window: AnyWindowHandle,
        workspace: &Entity<Workspace>,
        model: &Entity<ReviewModel>,
        cx: &mut AsyncApp,
    ) {
        let (github, pull) = cx.update(|cx| {
            let ws = workspace.read(cx);
            (ws.github.clone(), ws.pull.clone())
        });
        let ui =
            |cx: &mut AsyncApp,
             f: &dyn Fn(&mut Workspace, &mut Window, &mut Context<Workspace>)| {
                window
                    .update(cx, |_, window, cx| {
                        workspace.update(cx, |ws, cx| f(ws, window, cx))
                    })
                    .ok();
            };
        if let Some(id) = &self.focus_thread {
            ui(cx, &|ws, window, cx| {
                ws.focus_thread(id.clone(), window, cx)
            });
            wait(cx, "the thread's file", |cx| model.read(cx).is_ready()).await;
        }
        if let Some(id) = &self.resolve_thread {
            cx.update(|cx| pull.update(cx, |p, cx| p.toggle_resolved(id.clone(), cx)));
            wait(cx, "resolving", |cx| pull.read(cx).busy.is_none()).await;
            wait(cx, "the threads", |cx| pull.read(cx).activity.is_some()).await;
        }
        if let Some(id) = &self.reply_thread {
            ui(cx, &|ws, window, cx| {
                ws.focus_thread(id.clone(), window, cx);
                ws.start_reply(id.clone(), window, cx);
            });
            settle(cx).await;
            if let Some(text) = &self.reply_text {
                ui(cx, &|ws, window, cx| {
                    if let Some(input) = &ws.reply_input {
                        input.update(cx, |input, cx| input.set_value(text.clone(), window, cx));
                    }
                });
            }
            if self.send_reply {
                ui(cx, &|ws, window, cx| ws.send_reply(window, cx));
                wait(cx, "the reply", |cx| {
                    let p = pull.read(cx);
                    p.busy.is_none() && p.replying.is_none()
                })
                .await;
            }
        }
        if self.head_move {
            let world = WORLD
                .get()
                .unwrap_or_else(|| fail("--head-move needs --fake-github".into()));
            eprintln!("moved the fake head to {}", world.move_head());
            cx.update(|cx| pull.update(cx, |p, cx| p.check_head(true, cx)));
            wait(cx, "the moved head", |cx| pull.read(cx).moved_to.is_some()).await;
        }
        if self.push_dialog || self.push {
            ui(cx, &|ws, _, cx| ws.open_push_dialog(cx));
            if self.push {
                ui(cx, &|ws, _, cx| {
                    if let Some(Dialog::PushNotes(d)) = &ws.dialog {
                        d.update(cx, |d, cx| d.push(cx));
                    }
                });
                wait(cx, "the push", |cx| pull.read(cx).busy.is_none()).await;
                wait(cx, "the notes", |cx| model.read(cx).is_ready()).await;
            }
        }
        if self.submit_dialog || self.submit_review {
            ui(cx, &|ws, window, cx| ws.open_submit_dialog(window, cx));
            ui(cx, &|ws, window, cx| {
                if let Some(Dialog::SubmitReview(d)) = &ws.dialog {
                    d.update(cx, |d, cx| {
                        if let Some(event) = self.submit_event {
                            d.set_event(event, cx);
                        }
                        if let Some(body) = &self.submit_body {
                            d.body
                                .update(cx, |input, cx| input.set_value(body.clone(), window, cx));
                        }
                    });
                }
            });
            if self.submit_review {
                ui(cx, &|ws, _, cx| {
                    if let Some(Dialog::SubmitReview(d)) = &ws.dialog {
                        d.update(cx, |d, cx| d.submit(cx));
                    }
                });
                wait(cx, "the submit", |cx| pull.read(cx).busy.is_none()).await;
            }
        }
        if self.settings {
            ui(cx, &|ws, window, cx| ws.open_github_settings(window, cx));
            if let Some(token) = &self.paste_token {
                ui(cx, &|ws, window, cx| {
                    if let Some(Dialog::GitHubSettings(d)) = &ws.dialog {
                        let token = token.clone();
                        d.update(cx, |d, cx| {
                            d.token
                                .update(cx, |input, cx| input.set_value(token, window, cx))
                        });
                    }
                });
            }
        }
        if self.any {
            wait(cx, "GitHub", |cx| !github.read(cx).is_busy()).await;
        }
    }
}

async fn wait_for_pull(
    cx: &mut AsyncApp,
    model: &Entity<ReviewModel>,
    pull: &Entity<PullModel>,
    github: &Entity<GitHubModel>,
) {
    wait(cx, "the pull request", |cx| {
        if let Some(error) = model.read(cx).status.as_ref().filter(|s| s.error) {
            fail(format!("opening the pull request: {}", error.text));
        }
        let g = github.read(cx);
        if g.client().is_none()
            && !g.is_busy()
            && g.status != ducky_session::github::GitHubStatus::Unchecked
        {
            fail(format!("GitHub: {}", g.status_label()));
        }
        let m = model.read(cx);
        let p = pull.read(cx);
        m.is_ready()
            && m.review.as_ref().is_some_and(|r| r.pull.is_some())
            && (p.activity.is_some() || p.activity_error.is_some())
            && (p.ci.is_some() || p.ci_error.is_some())
    })
    .await;
}

async fn settle(cx: &mut AsyncApp) {
    cx.background_executor()
        .timer(Duration::from_millis(300))
        .await;
}

async fn wait(cx: &mut AsyncApp, what: &str, done: impl Fn(&App) -> bool) {
    let start = Instant::now();
    loop {
        cx.background_executor()
            .timer(Duration::from_millis(50))
            .await;
        if cx.update(|cx| done(cx)) {
            return;
        }
        if start.elapsed() > TIMEOUT {
            fail(format!("{what}: timed out"));
        }
    }
}
