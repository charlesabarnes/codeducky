//! Notes onto a pull request's diff: each note becomes an inline comment where its lines are in
//! the PR's patch, found with the same matcher as local re-anchoring; the rest go in the body.

use std::collections::HashMap;

use ducky_review::matching::{MatchKind, match_anchor};
use ducky_review::patch::patch_side_lines;
use ducky_review::report::{fence_for, note_excerpt};
use ducky_review::summary::compare_notes;
use ducky_review::{Note, NoteId, NumberedLine, Side};

use crate::api::files::PullFile;
use crate::api::reviews::{ReviewComment, ReviewCommentInput, ReviewInput};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlacedNote {
    pub note: Note,
    pub comment: ReviewCommentInput,
    /// The note's code and context read the same in the PR; otherwise it was the nearest match.
    pub exact: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnplacedNote {
    pub note: Note,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Placement {
    pub placed: Vec<PlacedNote>,
    pub unplaced: Vec<UnplacedNote>,
}

pub fn comment_body(note: &Note) -> String {
    let text = note.body.trim();
    let text = if text.is_empty() { "_No text._" } else { text };
    format!("**{}:** {text}", note.severity.as_str())
}

/// The PR file a note belongs to: by its path, or by the path before a rename.
fn file_for<'a>(
    path: &str,
    by_path: &HashMap<&str, &'a PullFile>,
    by_previous: &HashMap<&str, &'a PullFile>,
) -> Option<&'a PullFile> {
    by_path.get(path).or_else(|| by_previous.get(path)).copied()
}

/// Places each note on the PR's patch for its file. `renames` holds local renames (new path to
/// old path) that the PR may show as a delete and an add.
pub fn place_notes(
    notes: &[Note],
    files: &[PullFile],
    renames: &HashMap<String, String>,
) -> Placement {
    let by_path: HashMap<&str, &PullFile> = files.iter().map(|f| (f.path.as_str(), f)).collect();
    let by_previous: HashMap<&str, &PullFile> = files
        .iter()
        .filter_map(|f| f.previous_path.as_deref().map(|p| (p, f)))
        .collect();
    let mut sides: HashMap<(Side, &str), Vec<NumberedLine>> = HashMap::new();

    let mut sorted: Vec<&Note> = notes.iter().collect();
    sorted.sort_by(|a, b| compare_notes(a, b));
    let mut placement = Placement::default();
    for note in sorted {
        let side = note.anchor.side;
        let unpaired_old = renames.get(&note.path).filter(|old| {
            side == Side::Old
                && by_path
                    .get(note.path.as_str())
                    .is_none_or(|f| f.previous_path.is_none())
                && by_path.contains_key(old.as_str())
        });
        let file = match unpaired_old {
            Some(old) => by_path.get(old.as_str()).copied(),
            None => file_for(&note.path, &by_path, &by_previous),
        };
        let unplaced = |reason: &str| UnplacedNote {
            note: note.clone(),
            reason: reason.to_owned(),
        };
        let Some(file) = file else {
            placement
                .unplaced
                .push(unplaced("File is not changed in the pull request"));
            continue;
        };
        let Some(patch) = file.patch.as_deref() else {
            placement.unplaced.push(unplaced(
                "GitHub shows no diff for this file (binary or too large)",
            ));
            continue;
        };
        let lines = sides
            .entry((side, file.path.as_str()))
            .or_insert_with(|| patch_side_lines(patch, side));
        let Some(found) = match_anchor(&note.anchor, lines) else {
            placement.unplaced.push(unplaced(if note.anchor.is_range() {
                "Lines are not all in one hunk of the pull request diff"
            } else {
                "Line is not in the pull request diff"
            }));
            continue;
        };
        let range = found.end_line > found.line;
        placement.placed.push(PlacedNote {
            note: note.clone(),
            exact: found.kind == MatchKind::Exact,
            comment: ReviewCommentInput {
                path: file.path.clone(),
                start_line: range.then_some(found.line),
                start_side: range.then_some(side),
                line: found.end_line,
                side,
                body: comment_body(note),
            },
        });
    }
    placement
}

fn indent(text: &str) -> String {
    text.split('\n')
        .map(|line| {
            if line.is_empty() {
                String::new()
            } else {
                format!("  {line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn body_item(note: &Note) -> String {
    let base = if note.anchor.side == Side::Old {
        " (base)"
    } else {
        ""
    };
    let excerpt = note_excerpt(note);
    let fence = fence_for(&excerpt);
    let text = note.body.trim();
    let text = if text.is_empty() { "_No text._" } else { text };
    [
        format!(
            "- **{}** in `{}`, {}{base}:",
            note.severity.as_str(),
            note.path,
            note.anchor.lines_label()
        ),
        String::new(),
        indent(text),
        String::new(),
        indent(&format!("{fence}\n{excerpt}\n{fence}")),
    ]
    .join("\n")
}

/// Notes that do not map onto the diff, written out for the review body.
pub fn review_body(notes: &[Note]) -> String {
    if notes.is_empty() {
        return String::new();
    }
    let mut sorted: Vec<&Note> = notes.iter().collect();
    sorted.sort_by(|a, b| compare_notes(a, b));
    let items: Vec<String> = sorted.into_iter().map(body_item).collect();
    format!(
        "Notes that do not map onto the diff:\n\n{}",
        items.join("\n\n")
    )
}

pub fn pending_review_input(
    commit_id: &str,
    placed: &[PlacedNote],
    body_notes: &[Note],
) -> ReviewInput {
    ReviewInput {
        commit_id: commit_id.to_owned(),
        body: review_body(body_notes),
        comments: placed.iter().map(|p| p.comment.clone()).collect(),
        event: None,
    }
}

/// Pairs the comments GitHub created with the notes they came from (creating a review does not
/// return comment ids).
pub fn comment_ids_by_note(
    placed: &[PlacedNote],
    comments: &[ReviewComment],
) -> HashMap<NoteId, u64> {
    let mut unused: Vec<&ReviewComment> = comments.iter().collect();
    let mut ids = HashMap::new();
    for PlacedNote { note, comment, .. } in placed {
        let found = unused.iter().position(|c| {
            c.path == comment.path
                && c.body == comment.body
                && c.line.is_none_or(|line| line == comment.line)
        });
        if let Some(index) = found {
            ids.insert(note.id.clone(), unused.remove(index).id);
        }
    }
    ids
}
