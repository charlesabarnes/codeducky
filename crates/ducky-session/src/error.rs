#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error(transparent)]
    Git(#[from] ducky_git::GitError),
    #[error(transparent)]
    Notes(#[from] ducky_notes::NotesError),
    #[error(transparent)]
    Host(#[from] ducky_host::HostError),
    #[error("herdr-core is not running, so only this machine's repositories can be opened")]
    LocalOnly,
    #[error("agents need herdr-core; start it (`hc server status`) and connect again")]
    AgentsNeedCore,
    #[error(transparent)]
    Core(#[from] ducky_hc::Error),
    #[error("{0} has no branch or commit to review yet")]
    NoHead(String),
    #[error("no base to compare against: {0}")]
    NoBase(String),
    #[error("{0} is not one of this review's changed files")]
    UnknownFile(String),
    #[error(transparent)]
    Anchor(#[from] ducky_review::AnchorError),
    #[error(transparent)]
    ViewAnchor(#[from] ducky_review::view_notes::ViewAnchorError),
    #[error(transparent)]
    Checklist(#[from] ducky_review::checklist::ChecklistFormatError),
    #[error("agents are off: {0}")]
    AgentsOff(String),
    #[error(transparent)]
    GitHub(#[from] ducky_github::GitHubError),
    #[error(
        "this pull request is read from GitHub without a checkout; open it from a checkout at its head for that"
    )]
    NeedsCheckout,
    #[error("{0} is not on GitHub (no github.com remote named origin)")]
    NotOnGitHub(String),
    #[error("a pull request review compares against the pull request's base; refresh it instead")]
    PullBase,
    #[error("those commits are no longer on this branch; pick another, or go back to All changes")]
    CommitsGone,
}

pub type Result<T, E = SessionError> = std::result::Result<T, E>;
