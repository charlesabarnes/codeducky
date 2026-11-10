use std::sync::Arc;

use ducky_git::{Head, Repo};
use ducky_github::pr_diff::{build_pr_changes, load_pr_snapshot};
use ducky_github::{Client, PullRequest, RepoRef, parse_github_remote};
use ducky_host::Host;
use ducky_notes::NotesRepo;
use ducky_review::{ReviewState, ReviewTarget};

use super::files::changed_files;
use super::{Checkout, PullContext};
use crate::error::{Result, SessionError};
use crate::notes::NotesService;
use crate::review::{Review, ReviewRequest};
use crate::sides::{Content, PullBlobs};

/// A checkout of the pull request's repository, on this machine or a herdr-core one.
#[derive(Clone)]
pub struct CheckoutRequest {
    pub host: Arc<dyn Host>,
    pub request: ReviewRequest,
}

/// Which pull request to open, and where.
#[derive(Clone)]
pub struct PullOpen {
    pub repo: RepoRef,
    pub number: u64,
    /// A checkout to use when its head is the pull request's, and to keep notes in either way.
    pub checkout: Option<CheckoutRequest>,
    /// Without a checkout, notes go in a folder per repository under this one, on this machine.
    pub notes_dir: String,
    pub local: Arc<dyn Host>,
}

impl PullOpen {
    fn notes_folder(&self) -> String {
        format!(
            "{}/{}/{}",
            self.notes_dir.trim_end_matches('/'),
            self.repo.owner,
            self.repo.name
        )
    }
}

/// Opens a pull request for review. On a checkout at its head the review reads that checkout
/// (so the editor and agents work); otherwise every file comes from the GitHub API.
pub fn open_pull(client: &Client, open: PullOpen) -> Result<Review> {
    let snapshot = load_pr_snapshot(client, &open.repo, open.number)?;
    let target = ReviewTarget::pull_request(open.number);
    let head_sha = snapshot.pull.pr.head_sha.clone();
    let local = match &open.checkout {
        Some(checkout) => {
            let repo = Repo::open(checkout.host.clone(), &checkout.request.path)?;
            let head = repo.head()?.sha;
            Some((checkout, repo, head))
        }
        None => None,
    };
    if let Some((checkout, repo, Some(head))) = &local
        && *head == head_sha
    {
        let request = ReviewRequest {
            base: Some(snapshot.merge_base_sha.clone()),
            path: repo.info().toplevel.clone(),
            ..checkout.request.clone()
        };
        let mut review = Review::open_checkout(checkout.host.clone(), request, Some(target))?;
        review.base = snapshot.pull.pr.base_ref.clone();
        review.pull = Some(PullContext {
            repo: open.repo.clone(),
            checkout: Checkout::AtHead {
                path: review.toplevel().to_owned(),
            },
            client: client.clone(),
            snapshot,
            opened: open,
        });
        return Ok(review);
    }

    let built = build_pr_changes(client, &snapshot)?;
    let files = changed_files(&built);
    let commits = client.pull_commits(&open.repo, open.number)?;
    let blobs = Arc::new(PullBlobs::new(
        client.clone(),
        open.repo.clone(),
        built.metas.clone(),
        &built.changes,
    ));
    let content = Content::GitHub(blobs);
    let (notes_repo, notes_host, checkout, request, root) = match &local {
        Some((checkout, repo, head)) => (
            NotesRepo::open(&**repo.host(), &repo.info().toplevel)?,
            repo.host().clone(),
            Checkout::Elsewhere {
                path: repo.info().toplevel.clone(),
                head: head.clone(),
            },
            checkout.request.clone(),
            repo.info().toplevel.clone(),
        ),
        None => (
            NotesRepo::at(open.notes_folder()).without_readme(),
            open.local.clone(),
            Checkout::None,
            ReviewRequest::local(open.notes_folder()),
            format!("github.com/{}", open.repo),
        ),
    };
    let store = notes_repo.review(target.clone())?;
    let service = NotesService::new(
        content.clone(),
        notes_host.clone(),
        store,
        snapshot.merge_base_sha.clone(),
        Some(head_sha.clone()),
        notes_repo.readme_path(),
    );
    let pr = &snapshot.pull.pr;
    let review = Review {
        request,
        head: Head {
            branch: Some(pr.head_ref.clone()),
            sha: Some(head_sha),
        },
        target,
        base: pr.base_ref.clone(),
        merge_base: snapshot.merge_base_sha.clone(),
        default_base: None,
        branches: Vec::new(),
        files,
        commits,
        commits_truncated: false,
        commit_stats: Default::default(),
        notes: Vec::new(),
        state: ReviewState::default(),
        notes_problem: None,
        since: None,
        pull: Some(PullContext {
            repo: open.repo.clone(),
            client: client.clone(),
            checkout,
            snapshot,
            opened: open,
        }),
        content,
        root,
        notes_host,
        service,
        notes_repo,
    };
    Ok(review.with_notes())
}

/// The GitHub repository a checkout's `origin` points at.
pub fn github_repo(repo: &Repo) -> Result<RepoRef> {
    let url = repo.remote_url("origin")?;
    url.as_deref()
        .and_then(parse_github_remote)
        .ok_or_else(|| SessionError::NotOnGitHub(repo.info().toplevel.clone()))
}

/// The open pull request from the reviewed branch, if there is one.
pub fn branch_pull(client: &Client, review: &Review) -> Result<Option<(RepoRef, PullRequest)>> {
    let (Some(repo), Some(branch)) = (review.repo(), review.head.branch.as_deref()) else {
        return Ok(None);
    };
    if review.pull.is_some() {
        return Ok(None);
    }
    let github = github_repo(repo)?;
    Ok(client
        .open_pull_for_branch(&github, branch, None)?
        .map(|pr| (github, pr)))
}
