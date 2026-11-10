//! Opening a pull request for review: from the inbox, by reference, or from a branch's chip
//! (which carries the branch's notes over).

use std::sync::Arc;

use ducky_github::{Client, RepoRef};
use ducky_host::LocalHost;
use ducky_session::Review;
use ducky_session::pull::{CheckoutRequest, PullOpen, carry_branch_notes, open_pull};
use gpui_kit::*;

use super::model::{ReviewModel, Work};
use crate::config;

/// Where notes on pull requests without a checkout go: `<config dir>/pulls/<owner>/<name>/`.
/// Scripted runs that set no config dir use a fresh folder per run under the temp dir instead.
fn pull_notes_dir(persist: bool) -> String {
    let scripted = !persist && std::env::var_os("CODEDUCKY_CONFIG_DIR").is_none();
    let base = match config::config_dir() {
        Some(dir) if !scripted => dir,
        _ => std::env::temp_dir().join(format!("codeducky-dev-{}", std::process::id())),
    };
    base.join("pulls").to_string_lossy().into_owned()
}

impl ReviewModel {
    /// `from_branch`: the branch review this pull request is opened from. Its checkout is used
    /// (and when its head is the pull request's, so are the editor and agents) and its open
    /// notes are carried over.
    pub fn open_pull(
        &mut self,
        client: Client,
        repo: RepoRef,
        number: u64,
        from_branch: Option<Review>,
        cx: &mut Context<Self>,
    ) {
        let candidate = from_branch
            .clone()
            .or_else(|| self.review.clone().filter(|review| review.pull.is_none()));
        let notes_dir = pull_notes_dir(self.persist);
        let target = repo.clone();
        let work: Work<(Review, usize)> = Box::new(move || {
            let open = PullOpen {
                checkout: candidate
                    .as_ref()
                    .and_then(|review| checkout_of(review, &target)),
                repo: target,
                number,
                notes_dir,
                local: Arc::new(LocalHost),
            };
            let review = open_pull(&client, open).map_err(|e| e.to_string())?;
            let Some(branch) = from_branch else {
                return Ok((review, 0));
            };
            let carried = carry_branch_notes(&branch, &review).map_err(|e| e.to_string())?;
            let review = if carried > 0 {
                review.refresh().map_err(|e| e.to_string())?
            } else {
                review
            };
            Ok((review, carried))
        });
        self.run(
            format!("opening {repo}#{number}"),
            cx,
            work,
            move |this, (review, carried), cx| {
                this.show_review(review, cx);
                if carried > 0 {
                    this.say(
                        format!(
                            "carried {carried} open note{} over from the branch",
                            if carried == 1 { "" } else { "s" }
                        ),
                        cx,
                    );
                }
            },
        );
    }
}

/// The review's checkout, when it is a clone of `repo` (blocking: asks git for its remote).
fn checkout_of(review: &Review, repo: &RepoRef) -> Option<CheckoutRequest> {
    let local = review.repo()?;
    let remote = ducky_session::pull::github_repo(local).ok()?;
    (remote == *repo).then(|| CheckoutRequest {
        host: local.host().clone(),
        request: review.request.clone(),
    })
}
