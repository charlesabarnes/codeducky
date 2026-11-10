//! What a pull request adds to one file's diff: threads on its lines and CI annotations, plus
//! the ones that are not on a line (outdated or file threads, annotations that do not fit).

use std::collections::{BTreeMap, HashMap, HashSet};

use ducky_github::CheckAnnotation;
use ducky_github::ci::UnplacedAnnotation;
use ducky_github::threads::ReviewThread;
use ducky_review::Side;
use ducky_review::view_notes::NoteView;
use ducky_session::pull::{file_annotations, file_threads};
use gpui_kit::*;

use crate::views::workspace::Workspace;

#[derive(Default)]
pub struct InlinePull {
    pub threads: BTreeMap<(Side, u32), Vec<ReviewThread>>,
    pub listed: Vec<ReviewThread>,
    pub annotations: BTreeMap<u32, Vec<CheckAnnotation>>,
    pub unplaced: Vec<UnplacedAnnotation>,
    pub run_names: HashMap<u64, String>,
}

impl InlinePull {
    /// Threads and annotations sit on the pull request's own diff, so only All changes shows
    /// them in place.
    pub fn for_file(ws: &Workspace, path: &str, cx: &App) -> Self {
        let model = ws.model.read(cx);
        let pull = ws.pull.read(cx);
        if pull.context().is_none() || model.note_view() != NoteView::All {
            return Self::default();
        }
        let placed = file_threads(pull.threads(), path);
        let mut inline = Self {
            threads: placed.by_line,
            listed: placed.listed,
            ..Self::default()
        };
        if let Some(ci) = &pull.ci {
            let paths = ws.review_paths(cx);
            let paths: HashSet<&str> = paths.iter().map(String::as_str).collect();
            let lines = model
                .diff
                .as_ref()
                .and_then(|d| d.diff.side_lines(Side::New))
                .map(|lines| lines.len() as u32);
            let placed = file_annotations(ci, &paths, path, lines);
            inline.annotations = placed.by_line;
            inline.unplaced = placed.unplaced;
            inline.run_names = ci.runs.iter().map(|r| (r.id, r.name.clone())).collect();
        }
        inline
    }
}
