use std::collections::BTreeMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use super::server::{Call, FakeGitHub, Reply};
use crate::{Client, RepoRef, Token};

pub const OWNER: &str = "acme";
pub const NAME: &str = "widgets";
pub const NUMBER: u64 = 7;
pub const BRANCH: &str = "feature/parser";
pub const VIEWER: &str = "duckreviewer";
pub const AUTHOR: &str = "octo";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Auth {
    SignedIn,
    /// `/user` answers 401.
    SignedOut,
    /// A classic token without the `repo` scope.
    MissingScopes,
}

#[derive(Debug, Clone, Copy)]
pub struct WorldOptions {
    pub auth: Auth,
    /// Check-run reads before the pending `test` run completes.
    pub polls_until_green: u32,
}

impl Default for WorldOptions {
    fn default() -> Self {
        Self {
            auth: Auth::SignedIn,
            polls_until_green: 2,
        }
    }
}

/// Every write the fake took, for tests to assert on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Write {
    CreateReview {
        event: Option<String>,
        comments: usize,
        body: String,
    },
    SubmitReview {
        review_id: u64,
        event: String,
        body: String,
    },
    UpdateReviewBody {
        review_id: u64,
        body: String,
    },
    AddThread {
        path: String,
        line: u32,
    },
    Reply {
        thread: String,
        body: String,
    },
    Resolve {
        thread: String,
        resolved: bool,
    },
}

#[derive(Debug, Clone)]
pub(super) enum Content {
    Text(String),
    Binary(Vec<u8>),
}

impl Content {
    pub fn bytes(&self) -> &[u8] {
        match self {
            Self::Text(text) => text.as_bytes(),
            Self::Binary(bytes) => bytes,
        }
    }

    pub fn oid(&self) -> String {
        hex_id(self.bytes())
    }
}

#[derive(Debug, Clone)]
pub(super) struct Commit {
    pub sha: String,
    pub message: String,
    pub files: BTreeMap<String, Content>,
}

#[derive(Debug, Clone)]
pub(super) struct Comment {
    pub id: u64,
    pub author: String,
    pub body: String,
    pub created_at: String,
    /// In the viewer's pending review.
    pub pending: bool,
}

#[derive(Debug, Clone)]
pub(super) struct Thread {
    pub id: String,
    pub path: String,
    pub line: Option<u32>,
    pub original_line: Option<u32>,
    pub start_line: Option<u32>,
    pub side: &'static str,
    pub file_level: bool,
    pub resolved_by: Option<String>,
    pub outdated: bool,
    pub comments: Vec<Comment>,
}

#[derive(Debug, Clone)]
pub(super) struct Pending {
    pub id: u64,
    pub body: String,
}

#[derive(Debug, Clone)]
pub(super) struct Submitted {
    pub id: u64,
    pub author: String,
    pub state: String,
    pub body: String,
}

pub(super) struct State {
    pub auth: Auth,
    pub commits: Vec<Commit>,
    pub threads: Vec<Thread>,
    pub pending: Option<Pending>,
    pub reviews: Vec<Submitted>,
    pub check_polls: u32,
    pub polls_until_green: u32,
    pub next_id: u64,
    pub writes: Vec<Write>,
}

impl State {
    pub fn next_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    pub fn head(&self) -> &Commit {
        self.commits.last().expect("commits")
    }

    pub fn base(&self) -> &Commit {
        &self.commits[0]
    }

    pub fn commit(&self, sha: &str) -> Option<&Commit> {
        self.commits.iter().find(|c| c.sha == sha)
    }

    pub fn pending_comments(&self) -> usize {
        self.threads
            .iter()
            .flat_map(|t| &t.comments)
            .filter(|c| c.pending)
            .count()
    }
}

/// One repository (`acme/widgets`) with pull request #7 from `feature/parser`: a merge base, two
/// commits, review threads, check runs with annotations, and an inbox around it.
pub struct FakeWorld {
    server: FakeGitHub,
    state: Arc<Mutex<State>>,
}

impl FakeWorld {
    pub fn start(options: WorldOptions) -> Self {
        let state = Arc::new(Mutex::new(initial_state(options)));
        let shared = state.clone();
        let server = FakeGitHub::start(move |call: &Call, base: &str| {
            let mut state = shared.lock().unwrap_or_else(|e| e.into_inner());
            Some(handle(&mut state, call, base))
        });
        Self { server, state }
    }

    pub fn url(&self) -> &str {
        &self.server.url
    }

    pub fn client(&self) -> Client {
        Client::with_base_url(Token::new("fake-github-token").expect("token"), self.url())
            .with_retry_wait(Duration::ZERO)
    }

    pub fn repo() -> RepoRef {
        RepoRef::new(OWNER, NAME)
    }

    pub fn calls(&self) -> Vec<Call> {
        self.server.calls()
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn head_sha(&self) -> String {
        self.state().head().sha.clone()
    }

    pub fn merge_base_sha(&self) -> String {
        self.state().base().sha.clone()
    }

    pub fn set_auth(&self, auth: Auth) {
        self.state().auth = auth;
    }

    /// Pushes another commit onto the pull request's branch; returns its sha.
    pub fn move_head(&self) -> String {
        let mut state = self.state();
        let mut files = state.head().files.clone();
        files.insert("src/parse.rs".into(), Content::Text(PARSE_MOVED.into()));
        let sha = hex_id(b"commit 3");
        state.commits.push(Commit {
            sha: sha.clone(),
            message: "Default the quantity to one".into(),
            files,
        });
        sha
    }

    pub fn writes(&self) -> Vec<Write> {
        self.state().writes.clone()
    }

    /// Text of a file at the pull request's head.
    pub fn head_text(&self, path: &str) -> Option<String> {
        match self.state().head().files.get(path)? {
            Content::Text(text) => Some(text.clone()),
            Content::Binary(_) => None,
        }
    }

    pub fn has_pending_review(&self) -> bool {
        self.state().pending.is_some()
    }

    pub fn pending_comment_count(&self) -> usize {
        self.state().pending_comments()
    }

    pub fn thread_resolved(&self, id: &str) -> Option<bool> {
        self.state()
            .threads
            .iter()
            .find(|t| t.id == id)
            .map(|t| t.resolved_by.is_some())
    }

    pub fn thread_comment_count(&self, id: &str) -> Option<usize> {
        self.state()
            .threads
            .iter()
            .find(|t| t.id == id)
            .map(|t| t.comments.len())
    }
}

fn handle(state: &mut State, call: &Call, base: &str) -> Reply {
    if state.auth == Auth::SignedOut {
        return Reply::json(serde_json::json!({ "message": "Bad credentials" })).status(401);
    }
    let reply = if call.path == "/graphql" {
        super::graphql::handle(state, call, base)
    } else {
        super::rest::handle(state, call, base)
    };
    reply.unwrap_or_else(|| Reply::json(serde_json::json!({ "message": "Not Found" })).status(404))
}

pub(super) fn hex_id(bytes: &[u8]) -> String {
    let part = |salt: u8| {
        let mut hasher = DefaultHasher::new();
        salt.hash(&mut hasher);
        bytes.hash(&mut hasher);
        hasher.finish()
    };
    format!("{:016x}{:016x}{:08x}", part(1), part(2), part(3) as u32)
}

pub(super) fn line_of(text: &str, needle: &str) -> u32 {
    text.lines()
        .position(|line| line.contains(needle))
        .map_or(1, |i| i as u32 + 1)
}

const LIB_BASE: &str = "//! Widgets: parse and total widget orders.

pub struct Order {
    pub id: u32,
    pub items: Vec<Item>,
}

pub struct Item {
    pub name: String,
    pub price_cents: u64,
    pub quantity: u32,
}

pub fn total(order: &Order) -> u64 {
    let mut sum = 0;
    for item in &order.items {
        sum += item.price_cents * item.quantity as u64;
    }
    sum
}

pub fn describe(order: &Order) -> String {
    format!(\"order {} with {} items\", order.id, order.items.len())
}
";

const LIB_FIRST: &str = "//! Widgets: parse and total widget orders.

pub mod parse;

pub struct Order {
    pub id: u32,
    pub items: Vec<Item>,
}

pub struct Item {
    pub name: String,
    pub price_cents: u64,
    pub quantity: u32,
}

pub fn total(order: &Order) -> u64 {
    order
        .items
        .iter()
        .map(|item| item.price_cents * u64::from(item.quantity))
        .sum()
}

pub fn describe(order: &Order) -> String {
    format!(\"order {} with {} items\", order.id, order.items.len())
}
";

const LIB_HEAD: &str = "//! Widgets: parse and total widget orders.

pub mod parse;

pub struct Order {
    pub id: u32,
    pub items: Vec<Item>,
}

pub struct Item {
    pub name: String,
    pub price_cents: u64,
    pub quantity: u32,
}

pub fn total(order: &Order) -> u64 {
    order
        .items
        .iter()
        .map(|item| item.price_cents * u64::from(item.quantity))
        .sum()
}

pub fn describe(order: &Order) -> String {
    let count = order.items.len();
    let plural = if count == 1 { \"\" } else { \"s\" };
    format!(\"order {} with {count} item{plural}\", order.id)
}

pub fn discounted(order: &Order, percent: u64) -> u64 {
    total(order) * (100 - percent) / 100
}
";

const PARSE: &str = "use crate::{Item, Order};

pub fn parse_order(text: &str) -> Option<Order> {
    let mut lines = text.lines();
    let id = lines.next()?.trim().parse().ok()?;
    let items = lines.map(parse_item).collect::<Option<Vec<_>>>()?;
    Some(Order { id, items })
}

fn parse_item(line: &str) -> Option<Item> {
    let mut parts = line.split(',');
    let name = parts.next()?.trim().to_owned();
    let price_cents = parts.next()?.trim().parse().ok()?;
    let quantity = parts.next()?.trim().parse().ok()?;
    Some(Item { name, price_cents, quantity })
}
";

const PARSE_MOVED: &str = "use crate::{Item, Order};

pub fn parse_order(text: &str) -> Option<Order> {
    let mut lines = text.lines().filter(|line| !line.trim().is_empty());
    let id = lines.next()?.trim().parse().ok()?;
    let items = lines.map(parse_item).collect::<Option<Vec<_>>>()?;
    Some(Order { id, items })
}

fn parse_item(line: &str) -> Option<Item> {
    let mut parts = line.split(',');
    let name = parts.next()?.trim().to_owned();
    let price_cents = parts.next()?.trim().parse().ok()?;
    let quantity = parts.next().map_or(Some(1), |q| q.trim().parse().ok())?;
    Some(Item { name, price_cents, quantity })
}
";

const README_BASE: &str = "# widgets

Totals widget orders.

## Usage

Call `total` with an order.
";

const README_HEAD: &str = "# widgets

Totals widget orders.

## Usage

Parse orders with `parse::parse_order`, then call `total` or `discounted`.
";

const OLD_DOC: &str = "# Old notes

This page is out of date.
";

const BUILD: &str = "fn main() {
    println!(\"cargo:rerun-if-changed=build.rs\");
    let unused = 1;
}
";

fn text(s: &str) -> Content {
    Content::Text(s.to_owned())
}

fn initial_state(options: WorldOptions) -> State {
    let png = |seed: u8| Content::Binary([&b"\x89PNG\r\n\x1a\n"[..], &[seed, 0, 0, 1]].concat());
    let base: BTreeMap<String, Content> = [
        ("src/lib.rs", text(LIB_BASE)),
        ("README.md", text(README_BASE)),
        ("docs/old.md", text(OLD_DOC)),
        ("logo.png", png(1)),
        ("build.rs", text(BUILD)),
    ]
    .into_iter()
    .map(|(path, content)| (path.to_owned(), content))
    .collect();
    let mut first = base.clone();
    first.insert("src/lib.rs".into(), text(LIB_FIRST));
    first.insert("src/parse.rs".into(), text(PARSE));
    let mut head = first.clone();
    head.insert("src/lib.rs".into(), text(LIB_HEAD));
    head.insert("README.md".into(), text(README_HEAD));
    head.remove("docs/old.md");
    head.insert("logo.png".into(), png(2));
    let commits = vec![
        Commit {
            sha: hex_id(b"merge base"),
            message: "Release 0.3".into(),
            files: base,
        },
        Commit {
            sha: hex_id(b"commit 1"),
            message: "Parse orders from text".into(),
            files: first,
        },
        Commit {
            sha: hex_id(b"commit 2"),
            message: "Discounts and a friendlier description".into(),
            files: head,
        },
    ];
    let comment = |id: u64, author: &str, body: &str, at: &str| Comment {
        id,
        author: author.into(),
        body: body.into(),
        created_at: at.into(),
        pending: false,
    };
    let threads = vec![
        Thread {
            id: "PRRT_discount".into(),
            path: "src/lib.rs".into(),
            line: Some(line_of(LIB_HEAD, "(100 - percent)")),
            original_line: Some(line_of(LIB_HEAD, "(100 - percent)")),
            start_line: None,
            side: "RIGHT",
            file_level: false,
            resolved_by: None,
            outdated: false,
            comments: vec![
                comment(
                    101,
                    "carol",
                    "Should this saturate when `percent` is over **100**?\n\n- `discounted(order, 150)` underflows",
                    "2026-11-08T10:00:00Z",
                ),
                comment(
                    102,
                    AUTHOR,
                    "Good catch, I'll clamp it.",
                    "2026-11-08T11:30:00Z",
                ),
            ],
        },
        Thread {
            id: "PRRT_sum".into(),
            path: "src/lib.rs".into(),
            line: Some(line_of(LIB_HEAD, ".sum()")),
            original_line: Some(line_of(LIB_HEAD, ".sum()")),
            start_line: None,
            side: "RIGHT",
            file_level: false,
            resolved_by: Some(AUTHOR.into()),
            outdated: false,
            comments: vec![comment(
                103,
                "dave",
                "nit: `u64::from` reads nicer than `as`.",
                "2026-11-07T09:00:00Z",
            )],
        },
        Thread {
            id: "PRRT_blank".into(),
            path: "src/parse.rs".into(),
            line: None,
            original_line: Some(4),
            start_line: None,
            side: "RIGHT",
            file_level: false,
            resolved_by: None,
            outdated: true,
            comments: vec![comment(
                104,
                "carol",
                "What happens on a blank line?",
                "2026-11-06T15:00:00Z",
            )],
        },
        Thread {
            id: "PRRT_readme".into(),
            path: "README.md".into(),
            line: None,
            original_line: None,
            start_line: None,
            side: "RIGHT",
            file_level: true,
            resolved_by: None,
            outdated: false,
            comments: vec![comment(
                105,
                "dave",
                "Could the README show a short example?",
                "2026-11-09T08:15:00Z",
            )],
        },
    ];
    let reviews = vec![
        Submitted {
            id: 201,
            author: "carol".into(),
            state: "COMMENTED".into(),
            body: String::new(),
        },
        Submitted {
            id: 202,
            author: "dave".into(),
            state: "APPROVED".into(),
            body: "Looks good.".into(),
        },
    ];
    State {
        auth: options.auth,
        commits,
        threads,
        pending: None,
        reviews,
        check_polls: 0,
        polls_until_green: options.polls_until_green,
        next_id: 1000,
        writes: Vec::new(),
    }
}
