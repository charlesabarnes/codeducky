//! The work Code Ducky hands an agent, and where on the agent's machine the notes live.

use ducky_notes::{NotesRepo, ReviewNotes};
use ducky_review::{Note, NoteId, ReviewTarget};

use crate::ticket::TaskKind;

#[derive(Debug, Clone, PartialEq)]
pub enum Task {
    /// Review the branch against `base` and write findings as notes.
    Review { base: String },
    /// Fix these notes and resolve them in the notes file. `more_open` counts open notes left
    /// out of the list to keep the message short.
    Fix { notes: Vec<Note>, more_open: usize },
    /// The person's own words, sent as they are.
    Custom { text: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FixScope {
    AllOpen,
    Selected(Vec<NoteId>),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FixError {
    #[error("there are no open notes to fix")]
    NothingToFix,
    #[error("no open note with id {}", .0.join(", "))]
    NotOpen(Vec<String>),
}

/// More notes than this in an all-open fix are counted, not listed.
pub const MAX_LISTED: usize = 25;

impl Task {
    pub fn review(base: impl Into<String>) -> Self {
        Self::Review { base: base.into() }
    }

    pub fn custom(text: impl Into<String>) -> Self {
        Self::Custom { text: text.into() }
    }

    /// The open notes in `notes` that `scope` picks, most severe first.
    pub fn fix(notes: &[Note], scope: &FixScope) -> Result<Self, FixError> {
        let open = notes.iter().filter(|n| n.is_open());
        let mut picked: Vec<Note> = match scope {
            FixScope::AllOpen => open.cloned().collect(),
            FixScope::Selected(ids) => {
                let missing: Vec<String> = ids
                    .iter()
                    .filter(|id| !notes.iter().any(|n| n.id == **id && n.is_open()))
                    .map(|id| id.as_str().to_owned())
                    .collect();
                if !missing.is_empty() {
                    return Err(FixError::NotOpen(missing));
                }
                open.filter(|n| ids.contains(&n.id)).cloned().collect()
            }
        };
        if picked.is_empty() {
            return Err(FixError::NothingToFix);
        }
        picked.sort_by_key(|n| n.severity.rank());
        let more_open = match scope {
            FixScope::AllOpen => picked.len().saturating_sub(MAX_LISTED),
            FixScope::Selected(_) => 0,
        };
        if more_open > 0 {
            picked.truncate(MAX_LISTED);
        }
        Ok(Self::Fix {
            notes: picked,
            more_open,
        })
    }

    pub fn kind(&self) -> TaskKind {
        match self {
            Self::Review { .. } => TaskKind::Review,
            Self::Fix { .. } => TaskKind::Fix,
            Self::Custom { .. } => TaskKind::Custom,
        }
    }
}

/// Paths as they are on the machine the agent runs on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskContext {
    pub repo_root: String,
    pub target: ReviewTarget,
    pub notes_path: String,
    pub readme_path: String,
}

impl TaskContext {
    /// Call [`ducky_notes::ReviewNotes::insert_notes`] with no notes first if the review may
    /// have no files yet: that creates `notes.json` and the README the prompt points at.
    pub fn new(repo_root: impl Into<String>, repo: &NotesRepo, review: &ReviewNotes) -> Self {
        Self {
            repo_root: repo_root.into(),
            target: review.target().clone(),
            notes_path: review.notes_path(),
            readme_path: repo.readme_path(),
        }
    }
}

#[cfg(test)]
mod tests {
    use ducky_review::{Anchor, Author, NewNote, Severity, Side, Timestamp};

    use super::*;

    pub fn note(id: &str, severity: Severity, line: u32) -> Note {
        let mut new = NewNote::new(
            "src/cart.rs",
            Anchor::at_line(Side::New, line, None),
            "body",
        );
        new.severity = severity;
        new.author = Author::Human;
        new.into_note(
            NoteId::new(id),
            "2026-11-10T10:00:00Z".parse::<Timestamp>().unwrap(),
        )
    }

    #[test]
    fn fix_picks_open_notes_most_severe_first() {
        let mut resolved = note("r1", Severity::Blocker, 1);
        resolved.resolve(
            Author::Human,
            None,
            "2026-11-10T11:00:00Z".parse::<Timestamp>().unwrap(),
        );
        let notes = vec![
            note("n1", Severity::Nit, 3),
            resolved,
            note("b1", Severity::Blocker, 9),
        ];
        let Task::Fix {
            notes: picked,
            more_open,
        } = Task::fix(&notes, &FixScope::AllOpen).unwrap()
        else {
            panic!()
        };
        let ids: Vec<&str> = picked.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, ["b1", "n1"]);
        assert_eq!(more_open, 0);

        let selected = FixScope::Selected(vec![NoteId::new("n1")]);
        let Task::Fix { notes: picked, .. } = Task::fix(&notes, &selected).unwrap() else {
            panic!()
        };
        assert_eq!(picked.len(), 1);

        let closed = FixScope::Selected(vec![NoteId::new("r1"), NoteId::new("zz")]);
        assert_eq!(
            Task::fix(&notes, &closed),
            Err(FixError::NotOpen(vec!["r1".into(), "zz".into()]))
        );
        assert_eq!(
            Task::fix(&[], &FixScope::AllOpen),
            Err(FixError::NothingToFix)
        );
    }

    #[test]
    fn a_long_all_open_fix_lists_the_first_and_counts_the_rest() {
        let notes: Vec<Note> = (0..30)
            .map(|i| note(&format!("n{i}"), Severity::Issue, i + 1))
            .collect();
        let Task::Fix {
            notes: picked,
            more_open,
        } = Task::fix(&notes, &FixScope::AllOpen).unwrap()
        else {
            panic!()
        };
        assert_eq!(picked.len(), MAX_LISTED);
        assert_eq!(more_open, 5);
    }
}
