use serde::{Deserialize, Serialize};

use crate::anchor::Anchor;
use crate::ids::NoteId;
use crate::time::Timestamp;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Nit,
    Suggestion,
    #[default]
    Issue,
    Blocker,
}

impl Severity {
    /// Least to most severe.
    pub const ALL: [Self; 4] = [Self::Nit, Self::Suggestion, Self::Issue, Self::Blocker];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Nit => "nit",
            Self::Suggestion => "suggestion",
            Self::Issue => "issue",
            Self::Blocker => "blocker",
        }
    }

    /// Most severe first, for sorting.
    pub fn rank(self) -> u8 {
        match self {
            Self::Blocker => 0,
            Self::Issue => 1,
            Self::Suggestion => 2,
            Self::Nit => 3,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteStatus {
    #[default]
    Open,
    Resolved,
    /// Closed without a fix: not worth doing, or not right.
    Dismissed,
}

impl NoteStatus {
    pub const ALL: [Self; 3] = [Self::Open, Self::Resolved, Self::Dismissed];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Resolved => "resolved",
            Self::Dismissed => "dismissed",
        }
    }
}

/// Who wrote a note or closed it: you, or a coding agent working in the repo.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Author {
    Human,
    Agent {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
}

impl Author {
    pub fn agent(name: impl Into<String>) -> Self {
        Self::Agent {
            name: Some(name.into()),
        }
    }

    pub fn is_agent(&self) -> bool {
        matches!(self, Self::Agent { .. })
    }

    /// `you`, the agent's name, or `an agent`.
    pub fn label(&self) -> &str {
        match self {
            Self::Human => "you",
            Self::Agent { name: Some(name) } => name,
            Self::Agent { name: None } => "an agent",
        }
    }
}

/// A note hand-written into the file without an author was most likely written by an agent.
impl Default for Author {
    fn default() -> Self {
        Self::Agent { name: None }
    }
}

/// The reply that closed a note, e.g. an agent saying what it changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resolution {
    pub by: Author,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub at: Timestamp,
}

/// The GitHub pull request review comment a note was pushed as.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubComment {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment_id: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Note {
    #[serde(default)]
    pub id: NoteId,
    #[serde(default)]
    pub status: NoteStatus,
    #[serde(default)]
    pub severity: Severity,
    pub path: String,
    pub anchor: Anchor,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub author: Author,
    #[serde(default)]
    pub created_at: Timestamp,
    #[serde(default)]
    pub updated_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<Resolution>,
    /// The anchored code was not found in the latest content: possibly resolved.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub anchor_lost: bool,
    /// Set when the note was made on a commit's version of the file and its line is gone from
    /// the final content: the anchor is on that commit's lines and is never re-anchored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// The note this one was copied from, e.g. from a branch review into its pull request review.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub carried_from: Option<NoteId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github: Option<GithubComment>,
}

/// What a caller supplies to add a note; the store assigns the id and timestamps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewNote {
    pub path: String,
    pub anchor: Anchor,
    pub body: String,
    pub severity: Severity,
    pub author: Author,
    pub commit: Option<String>,
}

impl NewNote {
    pub fn new(path: impl Into<String>, anchor: Anchor, body: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            anchor,
            body: body.into(),
            severity: Severity::default(),
            author: Author::Human,
            commit: None,
        }
    }

    pub fn into_note(self, id: NoteId, now: Timestamp) -> Note {
        Note {
            id,
            status: NoteStatus::Open,
            severity: self.severity,
            path: self.path,
            anchor: self.anchor,
            body: self.body,
            author: self.author,
            created_at: now,
            updated_at: now,
            resolution: None,
            anchor_lost: false,
            commit: self.commit,
            carried_from: None,
            github: None,
        }
    }
}

/// An edit of the note's text or severity; `None` leaves a field as it is.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NoteEdit {
    pub body: Option<String>,
    pub severity: Option<Severity>,
}

impl Note {
    pub fn is_open(&self) -> bool {
        self.status == NoteStatus::Open
    }

    /// Open, but its code is gone from the latest content.
    pub fn possibly_resolved(&self) -> bool {
        self.is_open() && self.anchor_lost
    }

    pub fn edit(&mut self, edit: NoteEdit, now: Timestamp) {
        if let Some(body) = edit.body {
            self.body = body;
        }
        if let Some(severity) = edit.severity {
            self.severity = severity;
        }
        self.updated_at = now;
    }

    pub fn resolve(&mut self, by: Author, text: Option<String>, now: Timestamp) {
        self.close(NoteStatus::Resolved, by, text, now);
    }

    pub fn dismiss(&mut self, by: Author, text: Option<String>, now: Timestamp) {
        self.close(NoteStatus::Dismissed, by, text, now);
    }

    fn close(&mut self, status: NoteStatus, by: Author, text: Option<String>, now: Timestamp) {
        self.status = status;
        self.resolution = Some(Resolution {
            by,
            text: text.unwrap_or_default(),
            at: now,
        });
        self.updated_at = now;
    }

    pub fn reopen(&mut self, now: Timestamp) {
        self.status = NoteStatus::Open;
        self.resolution = None;
        self.updated_at = now;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::side::Side;

    fn note() -> Note {
        NewNote::new("a.ts", Anchor::at_line(Side::New, 3, None), "Rename x")
            .into_note(NoteId::from("k3x9qa"), Timestamp(1))
    }

    #[test]
    fn resolves_and_reopens() {
        let mut note = note();
        note.resolve(
            Author::agent("claude-code"),
            Some("Renamed in a1b2c3".into()),
            Timestamp(5),
        );
        assert_eq!(note.status, NoteStatus::Resolved);
        assert_eq!(note.resolution.as_ref().unwrap().by.label(), "claude-code");
        assert_eq!(note.updated_at, Timestamp(5));
        note.reopen(Timestamp(9));
        assert!(note.is_open());
        assert_eq!(note.resolution, None);
    }

    #[test]
    fn edits_only_what_is_given() {
        let mut note = note();
        note.edit(
            NoteEdit {
                severity: Some(Severity::Blocker),
                ..NoteEdit::default()
            },
            Timestamp(2),
        );
        assert_eq!(
            (note.body.as_str(), note.severity),
            ("Rename x", Severity::Blocker)
        );
    }

    #[test]
    fn reads_a_minimal_hand_written_note() {
        let note: Note =
            serde_json::from_str(r#"{"path": "a.ts", "anchor": {"line": 4}, "body": "Why?"}"#)
                .unwrap();
        assert_eq!(note.anchor, Anchor::at_line(Side::New, 4, None));
        assert_eq!(note.status, NoteStatus::Open);
        assert_eq!(note.severity, Severity::Issue);
        assert_eq!(note.author, Author::Agent { name: None });
        assert!(note.id.is_empty());
    }

    #[test]
    fn writes_authors_as_tagged_objects() {
        assert_eq!(
            serde_json::to_string(&Author::Human).unwrap(),
            r#"{"kind":"human"}"#
        );
        assert_eq!(
            serde_json::to_string(&Author::agent("codex")).unwrap(),
            r#"{"kind":"agent","name":"codex"}"#
        );
    }
}
