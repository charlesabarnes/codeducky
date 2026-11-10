use crate::api::pulls::{PullDetail, PullReview};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewerState {
    Approved,
    ChangesRequested,
    Commented,
    Dismissed,
    Requested,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reviewer {
    /// A login, or a team slug.
    pub login: String,
    pub state: ReviewerState,
    pub team: bool,
}

fn decisive(state: &str) -> Option<ReviewerState> {
    match state {
        "APPROVED" => Some(ReviewerState::Approved),
        "CHANGES_REQUESTED" => Some(ReviewerState::ChangesRequested),
        "DISMISSED" => Some(ReviewerState::Dismissed),
        _ => None,
    }
}

/// Each reviewer's standing the way GitHub's sidebar shows it: a pending request wins (it was
/// re-requested), then the latest approve / request changes / dismissed, then "commented".
/// In order of each reviewer's first review, then requested teams.
pub fn reviewer_states(pull: &PullDetail, reviews: &[PullReview]) -> Vec<Reviewer> {
    let mut latest: Vec<(String, ReviewerState)> = Vec::new();
    let mut set = |login: &str, state: ReviewerState, overwrite: bool| match latest
        .iter_mut()
        .find(|(l, _)| l == login)
    {
        Some(entry) if overwrite => entry.1 = state,
        Some(_) => {}
        None => latest.push((login.to_owned(), state)),
    };
    for review in reviews {
        if review.author == pull.author || review.state == "PENDING" {
            continue;
        }
        if let Some(state) = decisive(&review.state) {
            set(&review.author, state, true);
        } else if review.state == "COMMENTED" {
            set(&review.author, ReviewerState::Commented, false);
        }
    }
    for login in &pull.requested_reviewers {
        set(login, ReviewerState::Requested, true);
    }
    latest
        .into_iter()
        .map(|(login, state)| Reviewer {
            login,
            state,
            team: false,
        })
        .chain(pull.requested_teams.iter().map(|slug| Reviewer {
            login: slug.clone(),
            state: ReviewerState::Requested,
            team: true,
        }))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::pulls::{PullRequest, PullState};

    fn pull() -> PullDetail {
        PullDetail {
            pr: PullRequest {
                number: 7,
                title: String::new(),
                html_url: String::new(),
                draft: false,
                head_sha: String::new(),
                head_ref: String::new(),
                base_ref: String::new(),
            },
            body: String::new(),
            state: PullState::Open,
            author: "octo".into(),
            base_sha: String::new(),
            head_repo: None,
            maintainer_can_modify: false,
            labels: Vec::new(),
            requested_reviewers: vec!["carol".into()],
            requested_teams: vec!["core".into()],
            additions: 0,
            deletions: 0,
            changed_files: 0,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn review(author: &str, state: &str) -> PullReview {
        PullReview {
            id: 1,
            node_id: None,
            author: author.into(),
            state: state.into(),
            body: String::new(),
            submitted_at: None,
            html_url: String::new(),
            commit_id: None,
        }
    }

    #[test]
    fn shows_each_reviewer_the_way_github_does() {
        let reviews = [
            review("alice", "CHANGES_REQUESTED"),
            review("alice", "COMMENTED"),
            review("bob", "COMMENTED"),
            review("carol", "APPROVED"),
            review("octo", "COMMENTED"),
            review("dave", "APPROVED"),
            review("dave", "DISMISSED"),
            review("erin", "PENDING"),
        ];
        let states: Vec<(String, ReviewerState, bool)> = reviewer_states(&pull(), &reviews)
            .into_iter()
            .map(|r| (r.login, r.state, r.team))
            .collect();
        assert_eq!(
            states,
            [
                ("alice".into(), ReviewerState::ChangesRequested, false),
                ("bob".into(), ReviewerState::Commented, false),
                ("carol".into(), ReviewerState::Requested, false),
                ("dave".into(), ReviewerState::Dismissed, false),
                ("core".into(), ReviewerState::Requested, true),
            ]
        );
    }
}
