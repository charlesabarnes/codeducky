use crate::anchor::{Anchor, AnchorError, create_anchor};
use crate::lines::NumberedLine;
use crate::matching::{AnchorMatch, MatchKind, match_anchor};
use crate::note::Note;
use crate::side::Side;

/// What the diff on screen is, for placing notes on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoteView {
    /// The branch against its base. Notes are stored against this.
    All,
    /// Since last look: the new side is the current content, the old side what you reviewed.
    Interdiff,
    /// One commit or a range: the new side is the file as of `sha`, the old side its parent's.
    Commit { sha: String },
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlacedNotes {
    /// Notes to draw on this diff: copies, with line numbers moved onto it where needed.
    pub placed: Vec<Note>,
    /// Notes on lines this diff does not show: the base side, or another commit.
    pub elsewhere: Vec<Note>,
}

/// Places a file's notes on the diff being shown. Stored anchors point at the final content (new
/// side) or the base (old side), except notes kept on a commit, which point at that commit's lines.
pub fn place_notes(
    notes: &[Note],
    new_lines: Option<&[NumberedLine]>,
    view: &NoteView,
) -> PlacedNotes {
    let mut result = PlacedNotes::default();
    for note in notes {
        let target = match (&note.commit, view) {
            (Some(commit), NoteView::Commit { sha }) if commit == sha => Some(note.clone()),
            (Some(_), _) => None,
            (None, NoteView::All) => Some(note.clone()),
            (None, _) if note.anchor_lost => Some(note.clone()),
            (None, _) if note.anchor.side == Side::Old => None,
            (None, NoteView::Interdiff) => Some(note.clone()),
            (None, NoteView::Commit { .. }) => new_lines
                .and_then(|lines| match_anchor(&note.anchor, lines))
                .map(|found| moved_to(note, &found)),
        };
        match target {
            Some(placed) => result.placed.push(placed),
            None => result.elsewhere.push(note.clone()),
        }
    }
    result
}

fn moved_to(note: &Note, found: &AnchorMatch) -> Note {
    let mut copy = note.clone();
    copy.anchor.line = found.line;
    if note.anchor.is_range() {
        copy.anchor.end_line = Some(found.end_line);
    }
    copy
}

/// A match good enough to say the commit's line is still in the final content: the same text and
/// most of its context. A range found intact counts its own lines after the first as agreeing context.
pub fn survives(anchor: &Anchor, found: Option<&AnchorMatch>) -> bool {
    let Some(found) = found else {
        return false;
    };
    if found.kind == MatchKind::Exact {
        return true;
    }
    let inner = anchor.anchored_text().len() - 1;
    let intact = if inner > 0 && (found.end_line - found.line) as usize == inner {
        inner
    } else {
        0
    };
    let context = anchor.before.len() + anchor.after.len() + intact;
    context > 0 && found.context_score + intact >= context.div_ceil(2)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewAnchor {
    pub anchor: Anchor,
    /// Set when the note stays on the commit's lines.
    pub commit: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ViewAnchorError {
    #[error("this side has no text lines")]
    NoText,
    #[error("comment on the new (right-hand) side here, or switch to All changes for base lines")]
    BaseSideOutsideAll,
    #[error(transparent)]
    Anchor(#[from] AnchorError),
}

/// Both sides' lines of the diff on screen.
#[derive(Debug, Clone, Copy, Default)]
pub struct ShownLines<'a> {
    pub old: Option<&'a [NumberedLine]>,
    pub new: Option<&'a [NumberedLine]>,
}

/// The anchor for a note made on this diff. In commit mode a line that still exists in the final
/// content is anchored there, so the note lives on like any other; a line that is gone later
/// stays on the commit's lines, marked with its sha. Old-side lines exist only in All changes.
pub fn anchor_for_view(
    view: &NoteView,
    side: Side,
    line: u32,
    end_line: Option<u32>,
    shown: ShownLines,
    final_lines: Option<&[NumberedLine]>,
) -> Result<ViewAnchor, ViewAnchorError> {
    let lines = match side {
        Side::Old => shown.old,
        Side::New => shown.new,
    }
    .ok_or(ViewAnchorError::NoText)?;
    let plain = |anchor| ViewAnchor {
        anchor,
        commit: None,
    };
    let sha = match view {
        NoteView::All => return Ok(plain(create_anchor(lines, line, side, end_line)?)),
        _ if side == Side::Old => return Err(ViewAnchorError::BaseSideOutsideAll),
        NoteView::Interdiff => return Ok(plain(create_anchor(lines, line, Side::New, end_line)?)),
        NoteView::Commit { sha } => sha,
    };
    let anchor = create_anchor(lines, line, Side::New, end_line)?;
    if let Some(final_lines) = final_lines {
        let found = match_anchor(&anchor, final_lines);
        if let Some(found) = found.filter(|found| survives(&anchor, Some(found))) {
            return Ok(plain(create_anchor(
                final_lines,
                found.line,
                Side::New,
                Some(found.end_line),
            )?));
        }
    }
    Ok(ViewAnchor {
        anchor,
        commit: Some(sha.clone()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::NoteId;
    use crate::lines::number_lines;
    use crate::note::NewNote;
    use crate::time::Timestamp;

    fn final_lines() -> Vec<NumberedLine> {
        number_lines(
            &[
                "import x",
                "",
                "function a() {",
                "  return total * 2",
                "}",
                "",
                "function b() {",
                "  return 1",
                "}",
                "",
            ]
            .join("\n"),
        )
    }

    /// The same file as of an earlier commit: a() sat lower, and a line later removed was there.
    fn commit_lines() -> Vec<NumberedLine> {
        number_lines(
            &[
                "import x",
                "import y",
                "",
                "function a() {",
                "  return total * 2",
                "}",
                "",
                "const legacy = y()",
                "",
            ]
            .join("\n"),
        )
    }

    fn note(id: &str, anchor: Anchor, commit: Option<&str>) -> Note {
        let mut note = NewNote::new("a.ts", anchor, id).into_note(NoteId::from(id), Timestamp(0));
        note.commit = commit.map(str::to_owned);
        note
    }

    fn all_notes() -> Vec<Note> {
        let on_final = create_anchor(&final_lines(), 4, Side::New, None).unwrap();
        let on_commit = create_anchor(&commit_lines(), 8, Side::New, None).unwrap();
        let mut on_base = Anchor::at_line(Side::Old, 2, None);
        on_base.code = vec!["old".into()];
        let mut gone = Anchor::at_line(Side::New, 9, None);
        gone.code = vec!["not anywhere".into()];
        vec![
            note("final", on_final, None),
            note("base", on_base, None),
            note("commit", on_commit.clone(), Some("c1")),
            note("other", on_commit, Some("c0")),
            note("gone", gone, None),
        ]
    }

    fn ids(notes: &[Note]) -> Vec<&str> {
        notes.iter().map(|note| note.id.as_str()).collect()
    }

    fn commit(sha: &str) -> NoteView {
        NoteView::Commit { sha: sha.into() }
    }

    #[test]
    fn shows_stored_anchors_in_all_changes_and_lists_commit_notes_apart() {
        let placed = place_notes(&all_notes(), Some(&final_lines()), &NoteView::All);
        assert_eq!(ids(&placed.placed), ["final", "base", "gone"]);
        assert_eq!(ids(&placed.elsewhere), ["commit", "other"]);
    }

    #[test]
    fn keeps_new_side_notes_in_place_on_an_interdiff_and_lists_base_side_ones_apart() {
        let placed = place_notes(&all_notes(), Some(&final_lines()), &NoteView::Interdiff);
        assert_eq!(ids(&placed.placed), ["final", "gone"]);
        assert_eq!(ids(&placed.elsewhere), ["base", "commit", "other"]);
    }

    #[test]
    fn moves_final_content_notes_onto_a_commits_lines_and_shows_that_commits_own_notes() {
        let notes = all_notes();
        let placed = place_notes(&notes, Some(&commit_lines()), &commit("c1"));
        let lines: Vec<_> = placed
            .placed
            .iter()
            .map(|n| (n.id.as_str(), n.anchor.line))
            .collect();
        assert_eq!(lines, [("final", 5), ("commit", 8)]);
        assert_eq!(ids(&placed.elsewhere), ["base", "other", "gone"]);
        assert_eq!(notes[0].anchor.line, 4);
    }

    #[test]
    fn anchors_a_commit_mode_note_on_the_final_content_while_its_line_survives() {
        let (finals, commits) = (final_lines(), commit_lines());
        let shown = ShownLines {
            old: None,
            new: Some(&commits),
        };
        let view = commit("c1");
        assert_eq!(
            anchor_for_view(&view, Side::New, 5, None, shown, Some(&finals)),
            Ok(ViewAnchor {
                anchor: create_anchor(&finals, 4, Side::New, None).unwrap(),
                commit: None
            })
        );
        assert_eq!(
            anchor_for_view(&view, Side::New, 8, None, shown, Some(&finals)),
            Ok(ViewAnchor {
                anchor: create_anchor(&commits, 8, Side::New, None).unwrap(),
                commit: Some("c1".into())
            })
        );
        let brace_file = number_lines("x\ny\n}\n");
        let brace = ShownLines {
            old: None,
            new: Some(&brace_file),
        };
        let stays = anchor_for_view(&view, Side::New, 3, None, brace, Some(&finals)).unwrap();
        assert_eq!(stays.commit.as_deref(), Some("c1"));
        let file_gone = anchor_for_view(&view, Side::New, 5, None, shown, None).unwrap();
        assert_eq!(file_gone.commit.as_deref(), Some("c1"));
    }

    #[test]
    fn refuses_base_side_lines_outside_all_changes() {
        let finals = final_lines();
        let shown = ShownLines {
            old: Some(&finals),
            new: Some(&finals),
        };
        assert_eq!(
            anchor_for_view(&NoteView::Interdiff, Side::Old, 2, None, shown, None),
            Err(ViewAnchorError::BaseSideOutsideAll)
        );
        assert_eq!(
            anchor_for_view(&NoteView::All, Side::Old, 2, None, shown, None)
                .unwrap()
                .anchor,
            create_anchor(&finals, 2, Side::Old, None).unwrap()
        );
        assert_eq!(
            anchor_for_view(&NoteView::Interdiff, Side::New, 4, None, shown, None)
                .unwrap()
                .anchor,
            create_anchor(&finals, 4, Side::New, None).unwrap()
        );
    }

    #[test]
    fn moves_both_ends_of_a_final_content_range_onto_the_commits_lines() {
        let range = note(
            "range",
            create_anchor(&final_lines(), 3, Side::New, Some(5)).unwrap(),
            None,
        );
        let placed = place_notes(&[range], Some(&commit_lines()), &commit("c1"));
        let spans: Vec<_> = placed
            .placed
            .iter()
            .map(|n| (n.anchor.line, n.anchor.end_line))
            .collect();
        assert_eq!(spans, [(4, Some(6))]);
    }

    #[test]
    fn anchors_a_range_made_on_a_commit_on_the_final_content_while_it_survives() {
        let (finals, commits) = (final_lines(), commit_lines());
        let on_commit = ShownLines {
            old: None,
            new: Some(&commits),
        };
        let expected = create_anchor(&finals, 3, Side::New, Some(5)).unwrap();
        let made = anchor_for_view(
            &commit("c1"),
            Side::New,
            4,
            Some(6),
            on_commit,
            Some(&finals),
        );
        assert_eq!(made.unwrap().anchor, expected);
        let on_final = ShownLines {
            old: None,
            new: Some(&finals),
        };
        let made = anchor_for_view(&NoteView::All, Side::New, 3, Some(5), on_final, None);
        assert_eq!(made.unwrap().anchor, expected);
    }
}
