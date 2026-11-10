use std::cmp::Ordering;

use crate::note::{Note, NoteStatus, Severity};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NoteCounts {
    pub total: usize,
    pub possibly_resolved: usize,
    by_status: [usize; 3],
    by_severity: [usize; 4],
}

impl NoteCounts {
    pub fn status(&self, status: NoteStatus) -> usize {
        self.by_status[status as usize]
    }

    pub fn severity(&self, severity: Severity) -> usize {
        self.by_severity[severity as usize]
    }
}

pub fn count_notes<'a>(notes: impl IntoIterator<Item = &'a Note>) -> NoteCounts {
    let mut counts = NoteCounts::default();
    for note in notes {
        counts.total += 1;
        counts.by_status[note.status as usize] += 1;
        counts.by_severity[note.severity as usize] += 1;
        if note.possibly_resolved() {
            counts.possibly_resolved += 1;
        }
    }
    counts
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum StatusFilter {
    All,
    /// Open notes: the default.
    #[default]
    Active,
    Status(NoteStatus),
    PossiblyResolved,
}

impl StatusFilter {
    pub fn matches(self, note: &Note) -> bool {
        match self {
            Self::All => true,
            Self::Active => note.is_open(),
            Self::Status(status) => note.status == status,
            Self::PossiblyResolved => note.possibly_resolved(),
        }
    }
}

/// By path, lost anchors first, then by line and the most severe first.
pub fn compare_notes(a: &Note, b: &Note) -> Ordering {
    a.path
        .cmp(&b.path)
        .then_with(|| b.anchor_lost.cmp(&a.anchor_lost))
        .then_with(|| a.anchor.line.cmp(&b.anchor.line))
        .then_with(|| a.severity.rank().cmp(&b.severity.rank()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anchor::Anchor;
    use crate::ids::NoteId;
    use crate::note::NewNote;
    use crate::side::Side;
    use crate::time::Timestamp;

    fn note(status: NoteStatus, severity: Severity, lost: bool) -> Note {
        let mut new = NewNote::new("a.ts", Anchor::at_line(Side::New, 1, None), "");
        new.severity = severity;
        let mut note = new.into_note(NoteId::from("x"), Timestamp(0));
        note.status = status;
        note.anchor_lost = lost;
        note
    }

    #[test]
    fn active_shows_open_notes_hiding_dismissed_and_resolved_ones() {
        let statuses = NoteStatus::ALL;
        let shown = |filter: StatusFilter| -> Vec<NoteStatus> {
            statuses
                .into_iter()
                .filter(|status| filter.matches(&note(*status, Severity::Issue, false)))
                .collect()
        };
        assert_eq!(shown(StatusFilter::Active), [NoteStatus::Open]);
        assert_eq!(
            shown(StatusFilter::Status(NoteStatus::Dismissed)),
            [NoteStatus::Dismissed]
        );
        assert_eq!(shown(StatusFilter::All), statuses);
        assert!(StatusFilter::PossiblyResolved.matches(&note(
            NoteStatus::Open,
            Severity::Nit,
            true
        )));
        assert!(!StatusFilter::PossiblyResolved.matches(&note(
            NoteStatus::Resolved,
            Severity::Nit,
            true
        )));
    }

    #[test]
    fn counts_by_status_and_severity() {
        let notes = [
            note(NoteStatus::Open, Severity::Blocker, true),
            note(NoteStatus::Open, Severity::Nit, false),
            note(NoteStatus::Resolved, Severity::Nit, true),
        ];
        let counts = count_notes(&notes);
        assert_eq!((counts.total, counts.possibly_resolved), (3, 1));
        assert_eq!(counts.status(NoteStatus::Open), 2);
        assert_eq!(counts.severity(Severity::Nit), 2);
        assert_eq!(counts.severity(Severity::Issue), 0);
    }

    #[test]
    fn sorts_lost_anchors_first_then_by_line_and_severity() {
        let mut notes = [
            note(NoteStatus::Open, Severity::Nit, false),
            note(NoteStatus::Open, Severity::Blocker, false),
            note(NoteStatus::Open, Severity::Issue, true),
        ];
        notes.sort_by(compare_notes);
        let order: Vec<_> = notes.iter().map(|n| n.severity).collect();
        assert_eq!(order, [Severity::Issue, Severity::Blocker, Severity::Nit]);
    }
}
