use ducky_host::HostError;
use ducky_review::{NoteId, ReviewTarget};

#[derive(Debug, thiserror::Error)]
pub enum NotesError {
    #[error(transparent)]
    Host(#[from] HostError),
    /// The file is not what Code Ducky expects. It is left as it is until someone fixes it.
    #[error("{path}: {problem}")]
    Malformed { path: String, problem: String },
    #[error("{path} is format version {found}; this Code Ducky reads up to version {supported}")]
    NewerVersion {
        path: String,
        found: u64,
        supported: u64,
    },
    #[error("{path} holds the notes of {found}, not {expected}")]
    WrongTarget {
        path: String,
        expected: ReviewTarget,
        found: ReviewTarget,
    },
    #[error("no note with id {0}")]
    NoteNotFound(NoteId),
    #[error("no checklist with id {0}")]
    ChecklistNotFound(String),
    #[error("`{0}` cannot be used as a branch folder")]
    InvalidBranch(String),
    #[error("{path} kept changing while saving; try again")]
    Contended { path: String },
    #[error("cannot find the git directory of {repo}: {message}")]
    Git { repo: String, message: String },
}

impl NotesError {
    pub(crate) fn malformed(path: &str, problem: impl ToString) -> Self {
        Self::Malformed {
            path: path.to_owned(),
            problem: problem.to_string(),
        }
    }
}
