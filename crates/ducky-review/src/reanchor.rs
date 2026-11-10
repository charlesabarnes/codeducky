use crate::anchor::{Anchor, create_anchor};
use crate::ids::NoteId;
use crate::lines::{NumberedLine, index_of_line};
use crate::matching::match_anchor;
use crate::note::Note;
use crate::side::Side;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reanchored {
    pub anchor: Anchor,
    pub anchor_lost: bool,
}

/// Finds the anchor again in `lines` (`None` when the side no longer exists) and refreshes its
/// code and context. A lost anchor is kept as it was, flagged.
pub fn reanchor(anchor: &Anchor, lines: Option<&[NumberedLine]>) -> Reanchored {
    let lost = || Reanchored {
        anchor: anchor.clone(),
        anchor_lost: true,
    };
    let Some(lines) = lines else {
        return lost();
    };
    if anchor.is_line_only()
        && index_of_line(lines, anchor.line).is_some()
        && index_of_line(lines, anchor.last_line()).is_some()
        && let Ok(filled) = create_anchor(lines, anchor.line, anchor.side, anchor.end_line)
    {
        return Reanchored {
            anchor: filled,
            anchor_lost: false,
        };
    }
    match_anchor(anchor, lines)
        .and_then(|found| create_anchor(lines, found.line, anchor.side, Some(found.end_line)).ok())
        .map_or_else(lost, |anchor| Reanchored {
            anchor,
            anchor_lost: false,
        })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteUpdate {
    pub id: NoteId,
    pub anchor: Anchor,
    pub anchor_lost: bool,
}

/// Re-anchors notes against the latest content and returns only the ones that moved, were
/// refreshed, lost or found again. `source` gives a file side's lines, `None` when that side
/// does not exist. Notes kept on a commit's lines point at content that never changes, so they
/// are left alone.
pub fn reanchor_notes<F, L>(notes: &[Note], mut source: F) -> Vec<NoteUpdate>
where
    F: FnMut(&str, Side) -> Option<L>,
    L: AsRef<[NumberedLine]>,
{
    notes
        .iter()
        .filter(|note| note.commit.is_none() && !note.id.is_empty())
        .filter_map(|note| {
            let lines = source(&note.path, note.anchor.side);
            let result = reanchor(&note.anchor, lines.as_ref().map(AsRef::as_ref));
            let unchanged = result.anchor_lost == note.anchor_lost && result.anchor == note.anchor;
            (!unchanged).then(|| NoteUpdate {
                id: note.id.clone(),
                anchor: result.anchor,
                anchor_lost: result.anchor_lost,
            })
        })
        .collect()
}

impl Note {
    pub fn apply_update(&mut self, update: &NoteUpdate) {
        self.anchor = update.anchor.clone();
        self.anchor_lost = update.anchor_lost;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lines::number_lines;
    use crate::note::NewNote;
    use crate::time::Timestamp;

    const BASE: &str = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n";

    fn base() -> Vec<NumberedLine> {
        number_lines(BASE)
    }

    fn anchor(line: u32, end: Option<u32>) -> Anchor {
        create_anchor(&base(), line, Side::New, end).unwrap()
    }

    fn note(id: &str, anchor: Anchor) -> Note {
        NewNote::new("a.txt", anchor, "body").into_note(NoteId::from(id), Timestamp(0))
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn moves_the_anchor_and_refreshes_its_context() {
        let moved = reanchor(
            &anchor(4, None),
            Some(&number_lines(&format!("zero\n{BASE}"))),
        );
        assert_eq!(
            moved,
            Reanchored {
                anchor_lost: false,
                anchor: Anchor {
                    side: Side::New,
                    line: 5,
                    end_line: None,
                    code: strings(&["four"]),
                    before: strings(&["one", "two", "three"]),
                    after: strings(&["five", "six", "seven"]),
                },
            }
        );
    }

    #[test]
    fn keeps_the_old_anchor_and_flags_it_when_the_text_is_gone() {
        let original = anchor(4, None);
        assert_eq!(
            reanchor(&original, Some(&number_lines("one\ntwo\nthree\nfive\n"))),
            Reanchored {
                anchor: original,
                anchor_lost: true
            }
        );
    }

    #[test]
    fn fills_in_a_line_only_anchor_from_the_file() {
        let line_only = Anchor::at_line(Side::New, 2, None);
        assert_eq!(
            reanchor(&line_only, Some(&base())),
            Reanchored {
                anchor_lost: false,
                anchor: Anchor {
                    side: Side::New,
                    line: 2,
                    end_line: None,
                    code: strings(&["two"]),
                    before: strings(&["one"]),
                    after: strings(&["three", "four", "five"]),
                },
            }
        );
        assert!(reanchor(&Anchor::at_line(Side::New, 99, None), Some(&base())).anchor_lost);
    }

    #[test]
    fn flags_the_anchor_when_the_side_no_longer_exists() {
        assert!(reanchor(&anchor(4, None), None).anchor_lost);
    }

    #[test]
    fn returns_moved_refreshed_and_recovered_notes() {
        let mut lost = note("3", anchor(6, None));
        lost.anchor_lost = true;
        let notes = [note("1", anchor(2, None)), note("2", anchor(4, None)), lost];
        let edited = number_lines("one\ntwo\nthree\nNEW\nfour\nfive\nsix\nseven\n");
        let updates = reanchor_notes(&notes, |path, _| {
            (path == "a.txt").then_some(edited.as_slice())
        });
        let summary: Vec<_> = updates
            .iter()
            .map(|update| (update.id.as_str(), update.anchor.line, update.anchor_lost))
            .collect();
        assert_eq!(summary, [("1", 2, false), ("2", 5, false), ("3", 7, false)]);
        assert_eq!(updates[0].anchor.after, strings(&["three", "NEW", "four"]));
    }

    #[test]
    fn reports_nothing_when_the_file_is_unchanged() {
        let lines = base();
        let notes = [note("1", anchor(2, None)), note("2", anchor(7, None))];
        assert!(reanchor_notes(&notes, |_, _| Some(lines.as_slice())).is_empty());
    }

    #[test]
    fn looks_lines_up_by_path_and_side() {
        let mut old = note("1", anchor(3, None));
        old.anchor.side = Side::Old;
        let lines = base();
        let mut calls = Vec::new();
        reanchor_notes(&[old], |path, side| {
            calls.push(format!("{path}:{}", side.as_str()));
            Some(lines.as_slice())
        });
        assert_eq!(calls, ["a.txt:old"]);
    }

    #[test]
    fn leaves_notes_kept_on_a_commit_alone() {
        let mut kept = note("1", anchor(3, None));
        kept.commit = Some("c1".into());
        assert!(reanchor_notes(&[kept], |_, _| None::<Vec<NumberedLine>>).is_empty());
    }

    #[test]
    fn moves_both_ends_of_a_range_and_refreshes_its_code() {
        let shifted = number_lines(&format!("zero\n{BASE}"));
        assert_eq!(
            reanchor(&anchor(3, Some(5)), Some(&shifted)),
            Reanchored {
                anchor_lost: false,
                anchor: create_anchor(&shifted, 4, Side::New, Some(6)).unwrap()
            }
        );
    }

    #[test]
    fn a_range_grows_with_lines_added_inside_it() {
        let edited = number_lines("one\ntwo\nthree\nthree and a half\nfour\nfive\nsix\nseven\n");
        let result = reanchor(&anchor(3, Some(5)), Some(&edited));
        assert!(!result.anchor_lost);
        assert_eq!((result.anchor.line, result.anchor.end_line), (3, Some(6)));
        assert_eq!(
            result.anchor.code,
            strings(&["three", "three and a half", "four", "five"])
        );
    }

    #[test]
    fn a_range_is_lost_keeping_its_anchor_when_an_end_is_gone() {
        let range = anchor(3, Some(5));
        assert_eq!(
            reanchor(
                &range,
                Some(&number_lines("one\ntwo\nfour\nfive\nsix\nseven\n"))
            ),
            Reanchored {
                anchor: range,
                anchor_lost: true
            }
        );
    }

    #[test]
    fn fills_in_a_line_only_range_from_the_file() {
        let line_only = Anchor::at_line(Side::New, 2, Some(4));
        assert_eq!(
            reanchor(&line_only, Some(&base())),
            Reanchored {
                anchor_lost: false,
                anchor: anchor(2, Some(4))
            }
        );
        let too_far = Anchor::at_line(Side::New, 2, Some(99));
        assert!(reanchor(&too_far, Some(&base())).anchor_lost);
    }

    #[test]
    fn reports_a_range_whose_end_moved_even_when_its_start_did_not() {
        let notes = [note("1", anchor(3, Some(5)))];
        let edited = number_lines("one\ntwo\nthree\nNEW\nfour\nfive\nsix\nseven\n");
        let updates = reanchor_notes(&notes, |_, _| Some(edited.as_slice()));
        let spans: Vec<_> = updates
            .iter()
            .map(|u| (u.anchor.line, u.anchor.end_line))
            .collect();
        assert_eq!(spans, [(3, Some(6))]);
        let lines = base();
        assert!(reanchor_notes(&notes, |_, _| Some(lines.as_slice())).is_empty());
    }
}
