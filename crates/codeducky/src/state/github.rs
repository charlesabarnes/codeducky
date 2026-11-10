//! The GitHub connection the whole app shares: who is signed in and how, the fallback token,
//! the inbox. Nothing talks to GitHub until something needs it (the inbox, a pull request).

use std::sync::Arc;
use std::time::SystemTime;

use ducky_github::inbox::{Inbox, fetch_inbox};
use ducky_github::{Client, GitHubError, RepoRef, Token, TokenProvider};
use ducky_host::{Host, LocalHost};
use ducky_review::Timestamp;
use ducky_session::github::{GitHubLogin, GitHubStatus, TokenOrigin, sign_in};
use gpui_kit::*;

use super::token_store::TokenStore;

/// How this run reaches GitHub. Dev runs either use a fake GitHub (any write allowed, a fixed
/// fake token, never api.github.com) or the real API read-only and for one repository.
#[derive(Clone)]
pub struct GitHubSetup {
    /// `None`: api.github.com.
    pub base_url: Option<String>,
    /// A fixed fake token: never `gh`, never the Keychain.
    pub fake: bool,
    pub read_only: bool,
    /// Real-API dev runs only read this repository.
    pub only_repo: Option<RepoRef>,
    pub store: TokenStore,
}

impl GitHubSetup {
    pub fn real() -> Self {
        Self {
            base_url: None,
            fake: false,
            read_only: false,
            only_repo: None,
            store: TokenStore::platform(),
        }
    }

    #[cfg_attr(not(feature = "screenshot"), allow(dead_code))]
    pub fn fake(base_url: String) -> Self {
        Self {
            base_url: Some(base_url),
            fake: true,
            read_only: false,
            only_repo: None,
            store: TokenStore::memory(),
        }
    }

    /// A scripted run against the real API: reads only, one repository, token kept in memory.
    #[cfg_attr(not(feature = "screenshot"), allow(dead_code))]
    pub fn dev_real(repo: RepoRef) -> Self {
        Self {
            base_url: None,
            fake: false,
            read_only: true,
            only_repo: Some(repo),
            store: TokenStore::memory(),
        }
    }

    pub fn check_repo(&self, repo: &RepoRef) -> Result<(), String> {
        match &self.only_repo {
            Some(only) if only != repo => Err(format!(
                "this dev run only reads {only} on the real GitHub API, not {repo}"
            )),
            _ => Ok(()),
        }
    }

    pub fn inbox_allowed(&self) -> Result<(), String> {
        match &self.only_repo {
            Some(only) => Err(format!(
                "this dev run only reads {only} on the real GitHub API; the inbox searches every \
                 repository, so it is off"
            )),
            None => Ok(()),
        }
    }
}

pub enum GitHubEvent {
    SignedIn,
    Failed(String),
}

impl EventEmitter<GitHubEvent> for GitHubModel {}

type Waiter = Box<dyn FnOnce(&mut GitHubModel, Client, &mut Context<GitHubModel>)>;

pub struct GitHubModel {
    pub setup: GitHubSetup,
    pub status: GitHubStatus,
    pub login: Option<GitHubLogin>,
    pub inbox: Option<Inbox>,
    pub inbox_error: Option<String>,
    pub inbox_loading: bool,
    /// The inbox screen is showing.
    pub inbox_open: bool,
    /// The highlighted inbox row, counted across sections.
    pub inbox_cursor: usize,
    /// `gh` runs on the machine the app runs on: through herdr-core when one runs.
    local: Arc<dyn Host>,
    waiters: Vec<Waiter>,
}

impl GitHubModel {
    pub fn new(setup: GitHubSetup) -> Self {
        Self {
            setup,
            status: GitHubStatus::Unchecked,
            login: None,
            inbox: None,
            inbox_error: None,
            inbox_loading: false,
            inbox_open: false,
            inbox_cursor: 0,
            local: Arc::new(LocalHost),
            waiters: Vec::new(),
        }
    }

    pub fn set_local_host(&mut self, host: Arc<dyn Host>) {
        self.local = host;
    }

    pub fn client(&self) -> Option<Client> {
        self.login.as_ref().map(|l| l.client.clone())
    }

    pub fn viewer(&self) -> Option<&str> {
        self.login.as_ref().map(|l| l.viewer.login.as_str())
    }

    pub fn is_busy(&self) -> bool {
        self.status == GitHubStatus::Checking || self.inbox_loading
    }

    /// Runs `then` with a signed-in client, signing in first when needed. Dropped when signing
    /// in fails (the failure is reported once).
    pub fn with_client(
        &mut self,
        cx: &mut Context<Self>,
        then: impl FnOnce(&mut Self, Client, &mut Context<Self>) + 'static,
    ) {
        if let Some(client) = self.client() {
            then(self, client, cx);
            return;
        }
        self.waiters.push(Box::new(then));
        if self.status != GitHubStatus::Checking {
            self.sign_in(cx);
        }
    }

    pub fn sign_in(&mut self, cx: &mut Context<Self>) {
        self.status = GitHubStatus::Checking;
        self.login = None;
        cx.notify();
        let setup = self.setup.clone();
        let host = self.local.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { connect(&setup, host) })
                .await;
            this.update(cx, |this, cx| this.signed_in(result, cx)).ok();
        })
        .detach();
    }

    fn signed_in(&mut self, result: Result<GitHubLogin, GitHubError>, cx: &mut Context<Self>) {
        let waiters = std::mem::take(&mut self.waiters);
        match result {
            Ok(login) => {
                self.status = GitHubStatus::from_login(&login);
                let client = login.client.clone();
                self.login = Some(login);
                cx.emit(GitHubEvent::SignedIn);
                for waiter in waiters {
                    waiter(self, client.clone(), cx);
                }
            }
            Err(error) => {
                self.status = GitHubStatus::from_error(&error);
                if self.inbox_loading {
                    self.inbox_loading = false;
                    self.inbox_error = Some(error.message.clone());
                }
                cx.emit(GitHubEvent::Failed(error.message));
            }
        }
        cx.notify();
    }

    /// Notes a failure from any GitHub call: rate limits and a revoked token show in the status.
    pub fn note_error(&mut self, error: &GitHubError, cx: &mut Context<Self>) {
        let status = GitHubStatus::from_error(error);
        if !matches!(status, GitHubStatus::Failed { .. }) {
            if matches!(status, GitHubStatus::SignedOut { .. }) {
                self.login = None;
            }
            self.status = status;
            cx.notify();
        }
    }

    pub fn save_token(&mut self, token: String, cx: &mut Context<Self>) {
        let store = self.setup.store.clone();
        self.run_store(cx, move || store.save(&token));
    }

    pub fn forget_token(&mut self, cx: &mut Context<Self>) {
        let store = self.setup.store.clone();
        self.run_store(cx, move || store.clear());
    }

    fn run_store(
        &mut self,
        cx: &mut Context<Self>,
        work: impl FnOnce() -> Result<(), String> + Send + 'static,
    ) {
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { work() }).await;
            this.update(cx, |this, cx| match result {
                Ok(()) => this.sign_in(cx),
                Err(error) => cx.emit(GitHubEvent::Failed(error)),
            })
            .ok();
        })
        .detach();
    }

    pub fn open_inbox(&mut self, cx: &mut Context<Self>) {
        self.inbox_open = true;
        if self.inbox.is_none() && !self.inbox_loading {
            self.refresh_inbox(cx);
        }
        cx.notify();
    }

    pub fn close_inbox(&mut self, cx: &mut Context<Self>) {
        self.inbox_open = false;
        cx.notify();
    }

    pub fn refresh_inbox(&mut self, cx: &mut Context<Self>) {
        if let Err(reason) = self.setup.inbox_allowed() {
            self.inbox_error = Some(reason);
            cx.notify();
            return;
        }
        self.inbox_loading = true;
        cx.notify();
        self.with_client(cx, |_, client, cx| {
            cx.spawn(async move |this, cx| {
                let result = cx
                    .background_executor()
                    .spawn(async move { fetch_inbox(&client, Timestamp::now()) })
                    .await;
                this.update(cx, |this, cx| {
                    this.inbox_loading = false;
                    match result {
                        Ok(inbox) => {
                            this.inbox = Some(inbox);
                            this.inbox_error = None;
                        }
                        Err(error) => {
                            this.note_error(&error, cx);
                            this.inbox_error = Some(error.message);
                        }
                    }
                    cx.notify();
                })
                .ok();
            })
            .detach();
        });
    }

    pub fn status_label(&self) -> String {
        self.status.label(SystemTime::now())
    }
}

fn connect(setup: &GitHubSetup, host: Arc<dyn Host>) -> Result<GitHubLogin, GitHubError> {
    let base = setup.base_url.as_deref();
    if setup.fake {
        let token = Token::new("fake-github-token").expect("a fixed token");
        return sign_in(token, TokenOrigin::Fake, base, setup.read_only);
    }
    if base.is_some() {
        return Err(GitHubError::new(
            ducky_github::ErrorKind::NoToken,
            0,
            "Refusing to send a real GitHub token anywhere but api.github.com.",
        ));
    }
    let fallback = setup.store.load().unwrap_or_else(|error| {
        eprintln!("GitHub token store: {error}");
        None
    });
    let (token, source) = TokenProvider::new(host).with_fallback(fallback).token()?;
    sign_in(token, source.into(), base, setup.read_only)
}
