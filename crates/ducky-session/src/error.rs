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
    #[error("{0} has no branch or commit to review yet")]
    NoHead(String),
    #[error("no base to compare against: {0}")]
    NoBase(String),
    #[error("{0} is not one of this review's changed files")]
    UnknownFile(String),
    #[error(transparent)]
    Anchor(#[from] ducky_review::AnchorError),
}

pub type Result<T, E = SessionError> = std::result::Result<T, E>;
