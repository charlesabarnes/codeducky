//! The review on screen and everything the views show about it. Work below the UI runs on the
//! background executor; results come back here and views re-render from this state.

use std::collections::{BTreeSet, HashSet};

use ducky_review::order::FileOrder;
use ducky_review::summary::StatusFilter;
use ducky_review::view_notes::{NoteView, PlacedNotes, ShownLines, place_notes};
use ducky_review::{Note, NoteId, NumberedLine, ReviewState, Severity, Side};
use ducky_session::{
    ChangedFile, Checklists, Connection, CoreTarget, DiffOptions, FileDiff, NoteDraft, Review,
    ReviewMode, ReviewRequest, ReviewView, TreeRow, build_tree, changed_notes, matches_filter,
    order,
};
use gpui_kit::component::diff::DiffFile;
use gpui_kit::*;

use super::cursor::{self, LinePos};
use super::patch::unified_patch;
use crate::config::{self, DiffMode, Prefs, RecentRepo};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SidebarTab {
    #[default]
    Files,
    Notes,
    Checks,
}

/// What the main pane shows for the selected file.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Pane {
    #[default]
    Diff,
    Edit,
}

pub struct LoadedDiff {
    pub diff: FileDiff,
    /// The patch as gpui-kit's diff view takes it; `None` without text to show.
    pub file: Option<DiffFile>,
    pub positions: Vec<LinePos>,
    pub change_starts: Vec<usize>,
}

/// A note being written or edited, under its last line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Composer {
    pub path: String,
    pub side: Side,
    pub line: u32,
    pub end_line: Option<u32>,
    pub editing: Option<NoteId>,
    pub severity: Severity,
    pub body: String,
}

impl Composer {
    pub fn last_line(&self) -> u32 {
        self.end_line.unwrap_or(self.line)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub text: String,
    pub error: bool,
}

pub enum ModelEvent {
    /// A new file or a new version of it is ready for the diff view.
    DiffReady,
    ScrollTo(LinePos),
    /// The keyboard selection changed; `None` clears it.
    Select(Option<(LinePos, LinePos)>),
    ComposerOpened,
    ExpandAll,
    Error(String),
    /// A connection (first, or again after a retry) is in place.
    Connected,
    /// A review was opened, refreshed or re-based: agents follow it.
    ReviewOpened,
    /// Move the editor's cursor to this (1-based) line.
    EditorGoto(u32),
}

impl EventEmitter<ModelEvent> for ReviewModel {}

pub struct ReviewModel {
    pub prefs: Prefs,
    /// Off while dev scripting, so scripted states never reach the real preferences.
    pub persist: bool,
    pub connection: Option<Connection>,
    pub review: Option<Review>,
    /// What is loading, for the status bar.
    pub busy: Option<String>,
    pub selected: Option<String>,
    pub diff: Option<LoadedDiff>,
    pub order: FileOrder,
    pub filter: String,
    pub collapsed: HashSet<String>,
    pub tab: SidebarTab,
    pub notes_filter: StatusFilter,
    pub composer: Option<Composer>,
    pub cursor: Option<LinePos>,
    pub anchor: Option<LinePos>,
    pub status: Option<Status>,
    pub show_help: bool,
    pub show_base_picker: bool,
    /// Notes the last reload found new or changed (an agent resolved or added them).
    pub changed_notes: HashSet<NoteId>,
    /// Notes checked in the notes panel for a fix hand-off.
    pub fix_selection: BTreeSet<NoteId>,
    pub core_target: CoreTarget,
    /// Bumped with every new connection, so agents know to subscribe again.
    pub connection_generation: u64,
    pub mode: ReviewMode,
    /// What the mode shows; rebuilt when the mode or the review changes.
    pub view: Option<ReviewView>,
    /// The view's files as listed (since mode hides unchanged ones unless shown).
    pub visible: Vec<ChangedFile>,
    pub show_unchanged: bool,
    pub show_commit_picker: bool,
    pub since_banner_dismissed: bool,
    pub pane: Pane,
    /// The file the editor holds unsaved changes to.
    pub unsaved: Option<String>,
    pub checklists: Checklists,
    diff_generation: u64,
    pending_open: Option<ReviewRequest>,
}

pub(super) type Work<T> = Box<dyn FnOnce() -> Result<T, String> + Send>;

impl ReviewModel {
    pub fn new(prefs: Prefs) -> Self {
        Self {
            prefs,
            persist: true,
            connection: None,
            review: None,
            busy: Some("connecting to herdr-core".into()),
            selected: None,
            diff: None,
            order: FileOrder::Folders,
            filter: String::new(),
            collapsed: HashSet::new(),
            tab: SidebarTab::Files,
            notes_filter: StatusFilter::All,
            composer: None,
            cursor: None,
            anchor: None,
            status: None,
            show_help: false,
            show_base_picker: false,
            changed_notes: HashSet::new(),
            fix_selection: BTreeSet::new(),
            core_target: CoreTarget::Default,
            connection_generation: 0,
            mode: ReviewMode::All,
            view: None,
            visible: Vec::new(),
            show_unchanged: false,
            show_commit_picker: false,
            since_banner_dismissed: false,
            pane: Pane::Diff,
            unsaved: None,
            checklists: Checklists::default(),
            diff_generation: 0,
            pending_open: None,
        }
    }

    pub(super) fn run<T: Send + 'static>(
        &mut self,
        label: impl Into<String>,
        cx: &mut Context<Self>,
        work: Work<T>,
        done: impl FnOnce(&mut Self, T, &mut Context<Self>) + 'static,
    ) {
        self.busy = Some(label.into());
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { work() }).await;
            this.update(cx, |this, cx| {
                this.busy = None;
                match result {
                    Ok(value) => done(this, value, cx),
                    Err(error) => this.fail(error, cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn fail(&mut self, error: String, cx: &mut Context<Self>) {
        self.status = Some(Status {
            text: error.clone(),
            error: true,
        });
        cx.emit(ModelEvent::Error(error));
        cx.notify();
    }

    pub fn say(&mut self, text: impl Into<String>, cx: &mut Context<Self>) {
        self.status = Some(Status {
            text: text.into(),
            error: false,
        });
        cx.notify();
    }

    pub fn save_prefs(&self) {
        if !self.persist {
            return;
        }
        if let Err(error) = config::save(&self.prefs) {
            eprintln!("could not save preferences: {error}");
        }
    }

    pub fn connect(&mut self, cx: &mut Context<Self>) {
        let target = self.core_target.clone();
        self.run(
            "connecting to herdr-core",
            cx,
            Box::new(move || Ok(Connection::connect_to(target))),
            |this, connection, cx| {
                this.connection = Some(connection);
                this.connection_generation += 1;
                cx.emit(ModelEvent::Connected);
                if let Some(request) = this.pending_open.take() {
                    this.open(request, cx);
                }
            },
        );
    }

    /// Connects again (after herdr-core started or restarted) and reopens the review on the new
    /// connection, since its hosts went with the old one.
    pub fn reconnect(&mut self, cx: &mut Context<Self>) {
        if let Some(review) = &self.review {
            self.pending_open = Some(review.request.clone());
        }
        self.connection = None;
        self.connect(cx);
    }

    #[cfg(feature = "screenshot")]
    pub fn is_ready(&self) -> bool {
        self.busy.is_none() && self.pending_open.is_none()
    }

    pub fn open(&mut self, request: ReviewRequest, cx: &mut Context<Self>) {
        let Some(connection) = self.connection.clone() else {
            self.pending_open = Some(request);
            return;
        };
        let label = format!("opening {}", request.path);
        self.run(
            label,
            cx,
            Box::new(move || Review::open(&connection, request).map_err(|e| e.to_string())),
            |this, review, cx| {
                this.prefs.remember(RecentRepo {
                    path: review.toplevel().to_owned(),
                    machine: review.request.machine.clone(),
                });
                this.save_prefs();
                this.show_review(review, cx);
            },
        );
    }

    fn show_review(&mut self, review: Review, cx: &mut Context<Self>) {
        if let Some(problem) = &review.notes_problem {
            self.fail(format!("notes: {problem}"), cx);
        } else {
            self.status = None;
        }
        let same_review = self.review.as_ref().is_some_and(|old| {
            old.toplevel() == review.toplevel() && old.request.machine == review.request.machine
        });
        if !same_review {
            self.changed_notes.clear();
            self.fix_selection.clear();
            self.since_banner_dismissed = false;
            self.show_unchanged = false;
        }
        self.review = Some(review);
        if !same_review {
            self.mode = self.initial_mode();
            self.selected = None;
        }
        self.composer = None;
        cx.emit(ModelEvent::ReviewOpened);
        self.load_checklists(cx);
        self.rebuild_view(cx);
    }

    pub(super) fn first_file(&self) -> Option<String> {
        let ordered = self.ordered();
        ordered
            .iter()
            .find(|&&i| !self.is_viewed(self.visible[i].path()))
            .or(ordered.first())
            .map(|&i| self.visible[i].path().to_owned())
    }

    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        let Some(review) = self.review.clone() else {
            return;
        };
        self.run(
            "refreshing",
            cx,
            Box::new(move || review.refresh().map_err(|e| e.to_string())),
            |this, review, cx| {
                this.show_review(review, cx);
                this.say("refreshed", cx);
            },
        );
    }

    pub fn set_base(&mut self, base: String, cx: &mut Context<Self>) {
        let Some(review) = self.review.clone() else {
            return;
        };
        self.show_base_picker = false;
        self.run(
            format!("comparing with {base}"),
            cx,
            Box::new(move || review.with_base(base).map_err(|e| e.to_string())),
            |this, review, cx| this.show_review(review, cx),
        );
    }

    /// `quiet`: an automatic reload (focus, an agent's turn ended) that only speaks up when
    /// something changed.
    pub fn reload_notes(&mut self, quiet: bool, cx: &mut Context<Self>) {
        let Some(review) = self.review.as_ref() else {
            return;
        };
        let service = review.notes_service().clone();
        let files = review.files.clone();
        let before = review.notes.clone();
        let work: Work<(Vec<Note>, ReviewState)> = Box::new(move || {
            service.reanchor(&files).map_err(|e| e.to_string())?;
            Ok((
                service.notes().map_err(|e| e.to_string())?,
                service.state().map_err(|e| e.to_string())?,
            ))
        });
        let label = if quiet {
            "checking notes"
        } else {
            "reloading notes"
        };
        self.run(label, cx, work, move |this, (notes, state), cx| {
            let changed = changed_notes(&before, &notes);
            if !changed.is_empty() {
                this.changed_notes = changed;
                let count = this.changed_notes.len();
                this.say(
                    format!("{count} note{} changed", if count == 1 { "" } else { "s" }),
                    cx,
                );
            } else if !quiet {
                this.say("notes reloaded", cx);
            }
            this.fix_selection
                .retain(|id| notes.iter().any(|n| n.id == *id && n.is_open()));
            this.set_notes(notes, state, cx);
        });
    }

    pub fn toggle_fix_selection(&mut self, id: NoteId, cx: &mut Context<Self>) {
        if !self.fix_selection.remove(&id) {
            self.fix_selection.insert(id);
        }
        cx.notify();
    }

    fn set_notes(&mut self, notes: Vec<Note>, state: ReviewState, cx: &mut Context<Self>) {
        if let Some(review) = self.review.as_mut() {
            review.notes = notes;
            review.state = state;
        }
        cx.notify();
    }

    pub fn diff_options(&self) -> DiffOptions {
        DiffOptions {
            ignore_whitespace: self.prefs.ignore_whitespace,
        }
    }

    pub fn select(&mut self, path: String, cx: &mut Context<Self>) {
        if self.selected.as_deref() == Some(&path) && self.diff.is_some() {
            return;
        }
        if let Some(unsaved) = self.unsaved.clone().filter(|p| *p != path) {
            self.fail(
                format!("{unsaved} has unsaved changes: save them (cmd-s) or revert them first"),
                cx,
            );
            return;
        }
        self.load_diff(path, cx);
    }

    pub(super) fn load_diff(&mut self, path: String, cx: &mut Context<Self>) {
        let Some(review) = self.review.clone() else {
            return;
        };
        if self.selected.as_deref() != Some(&path) {
            self.cursor = None;
            self.anchor = None;
            self.composer = None;
        }
        self.selected = Some(path.clone());
        self.diff_generation += 1;
        let generation = self.diff_generation;
        let options = self.diff_options();
        let entry = self.entry(&path).cloned();
        self.run(
            format!("loading {path}"),
            cx,
            Box::new(move || {
                let diff = match &entry {
                    Some(entry) => review.load_entry_diff(entry, options),
                    None => review.load_diff(&path, options),
                }
                .map_err(|e| e.to_string())?;
                let file = unified_patch(&diff)
                    .and_then(|patch| DiffFile::parse(&patch).ok())
                    .and_then(|mut files| files.pop());
                let (positions, change_starts) = diff
                    .text()
                    .map(|text| (cursor::positions(text), cursor::change_starts(text)))
                    .unwrap_or_default();
                Ok(LoadedDiff {
                    diff,
                    file,
                    positions,
                    change_starts,
                })
            }),
            move |this, loaded, cx| {
                if generation != this.diff_generation {
                    return;
                }
                this.diff = Some(loaded);
                cx.emit(ModelEvent::DiffReady);
            },
        );
    }

    pub fn reload_diff(&mut self, cx: &mut Context<Self>) {
        if let Some(path) = self.selected.clone() {
            self.load_diff(path, cx);
        }
    }

    /// Indexes into [`Self::visible`] in review order, filtered.
    pub fn ordered(&self) -> Vec<usize> {
        let Some(review) = &self.review else {
            return Vec::new();
        };
        order(&self.visible, self.order, &review.notes)
            .into_iter()
            .filter(|&i| matches_filter(self.visible[i].path(), &self.filter))
            .collect()
    }

    pub fn tree(&self) -> Vec<TreeRow> {
        let nested = self.order == FileOrder::Folders;
        build_tree(&self.visible, &self.ordered(), nested, &self.collapsed)
    }

    pub fn toggle_folder(&mut self, path: String, cx: &mut Context<Self>) {
        if !self.collapsed.remove(&path) {
            self.collapsed.insert(path);
        }
        cx.notify();
    }

    /// Steps through the ordered, filtered files; `only_unviewed` skips viewed ones.
    pub fn step_file(
        &mut self,
        forward: bool,
        only_unviewed: bool,
        cx: &mut Context<Self>,
    ) -> bool {
        let ordered = self.ordered();
        let at = self
            .selected
            .as_deref()
            .and_then(|path| ordered.iter().position(|&i| self.visible[i].path() == path));
        let candidates: Vec<usize> = (0..ordered.len())
            .filter(|&k| !only_unviewed || !self.is_viewed(self.visible[ordered[k]].path()))
            .collect();
        let next = match (at, forward) {
            (None, _) => candidates.first().copied(),
            (Some(at), true) => candidates.iter().copied().find(|&k| k > at),
            (Some(at), false) => candidates.iter().rev().copied().find(|&k| k < at),
        };
        match next {
            Some(k) => {
                let path = self.visible[ordered[k]].path().to_owned();
                self.select(path, cx);
                true
            }
            None => false,
        }
    }

    pub fn toggle_viewed(&mut self, path: String, advance: bool, cx: &mut Context<Self>) {
        let Some(review) = self.review.as_ref() else {
            return;
        };
        let Some(file) = review.files.iter().find(|f| f.path() == path) else {
            self.say(
                "not in the final diff of the branch, so there is nothing to mark viewed",
                cx,
            );
            return;
        };
        let viewed = !review.is_viewed(file);
        let file = file.clone();
        let service = review.notes_service().clone();
        self.run(
            "saving",
            cx,
            Box::new(move || {
                service
                    .mark_viewed(&file, viewed)
                    .map_err(|e| e.to_string())
            }),
            move |this, state, cx| {
                if let Some(review) = this.review.as_mut() {
                    review.state = state;
                }
                if viewed && advance {
                    this.step_file(true, true, cx);
                }
            },
        );
    }

    pub fn set_mode(&mut self, mode: DiffMode, cx: &mut Context<Self>) {
        self.prefs.diff_mode = mode;
        self.save_prefs();
        cx.notify();
    }

    pub fn toggle_whitespace(&mut self, cx: &mut Context<Self>) {
        self.prefs.ignore_whitespace = !self.prefs.ignore_whitespace;
        self.save_prefs();
        self.reload_diff(cx);
    }

    pub fn toggle_wrap(&mut self, cx: &mut Context<Self>) {
        self.prefs.wrap = !self.prefs.wrap;
        self.save_prefs();
        cx.notify();
    }

    pub fn toggle_order(&mut self, cx: &mut Context<Self>) {
        self.order = match self.order {
            FileOrder::Folders => FileOrder::Risk,
            FileOrder::Risk => FileOrder::Folders,
        };
        cx.notify();
    }

    /// How notes are placed on the diff on screen.
    pub fn note_view(&self) -> NoteView {
        self.current_entry()
            .map_or(NoteView::All, |entry| entry.note_view.clone())
    }

    /// The selected file's notes, split into those drawn on this diff (with their lines moved
    /// onto it) and those it does not show.
    pub fn placed_notes(&self) -> PlacedNotes {
        let (Some(review), Some(path)) = (&self.review, &self.selected) else {
            return PlacedNotes::default();
        };
        let notes: Vec<Note> = review.notes_on(path).cloned().collect();
        let new_lines = self
            .diff
            .as_ref()
            .and_then(|loaded| loaded.diff.side_lines(Side::New));
        place_notes(&notes, new_lines, &self.note_view())
    }

    pub fn file_notes(&self) -> Vec<Note> {
        self.placed_notes().placed
    }

    fn side_lines(&self, side: Side) -> Option<Vec<NumberedLine>> {
        Some(self.diff.as_ref()?.diff.side_lines(side)?.to_vec())
    }

    pub fn start_compose(
        &mut self,
        side: Side,
        line: u32,
        end_line: Option<u32>,
        cx: &mut Context<Self>,
    ) {
        let Some(path) = self.selected.clone() else {
            return;
        };
        if self.side_lines(side).is_none() {
            self.fail("this side has no text lines to comment on".into(), cx);
            return;
        }
        if side == Side::Old && self.note_view() != NoteView::All {
            self.fail(
                "In this view, comment on the new (right-hand) side. Base lines take notes in \
                 All changes."
                    .into(),
                cx,
            );
            return;
        }
        let (line, end_line) = match end_line {
            Some(end) if end < line => (end, Some(line)),
            other => (line, other.filter(|end| *end != line)),
        };
        self.composer = Some(Composer {
            path,
            side,
            line,
            end_line,
            editing: None,
            severity: Severity::default(),
            body: String::new(),
        });
        cx.emit(ModelEvent::ComposerOpened);
        cx.notify();
    }

    /// Comments on the keyboard selection, or the focused line.
    pub fn comment_at_cursor(&mut self, cx: &mut Context<Self>) {
        let Some(cursor) = self.cursor.or_else(|| self.first_change()) else {
            return;
        };
        let end = self
            .anchor
            .filter(|anchor| anchor.side == cursor.side)
            .map(|anchor| anchor.line);
        self.start_compose(cursor.side, cursor.line, end, cx);
    }

    pub fn start_edit(&mut self, id: &NoteId, cx: &mut Context<Self>) {
        let Some(note) = self
            .review
            .as_ref()
            .and_then(|r| r.notes.iter().find(|n| n.id == *id))
        else {
            return;
        };
        self.composer = Some(Composer {
            path: note.path.clone(),
            side: note.anchor.side,
            line: note.anchor.line,
            end_line: note.anchor.end_line,
            editing: Some(note.id.clone()),
            severity: note.severity,
            body: note.body.clone(),
        });
        cx.emit(ModelEvent::ComposerOpened);
        cx.notify();
    }

    pub fn set_composer_severity(&mut self, severity: Severity, cx: &mut Context<Self>) {
        if let Some(composer) = self.composer.as_mut() {
            composer.severity = severity;
            cx.notify();
        }
    }

    pub fn cancel_compose(&mut self, cx: &mut Context<Self>) {
        self.composer = None;
        cx.notify();
    }

    pub fn save_composer(&mut self, body: String, cx: &mut Context<Self>) {
        let (Some(composer), Some(review)) = (self.composer.clone(), self.review.as_ref()) else {
            return;
        };
        if body.trim().is_empty() {
            self.fail("a note needs some text".into(), cx);
            return;
        }
        let service = review.notes_service().clone();
        let old_lines = self.side_lines(Side::Old);
        let new_lines = self.side_lines(Side::New);
        let view = self.note_view();
        let work: Work<(Vec<Note>, ReviewState)> = Box::new(move || {
            let result = match &composer.editing {
                Some(id) => service.edit(id, body, composer.severity).map(drop),
                None => {
                    let shown = ShownLines {
                        old: old_lines.as_deref(),
                        new: new_lines.as_deref(),
                    };
                    let draft = NoteDraft {
                        path: composer.path,
                        side: composer.side,
                        line: composer.line,
                        end_line: composer.end_line,
                        body,
                        severity: composer.severity,
                    };
                    service.add_in_view(draft, &view, shown).map(drop)
                }
            };
            result.map_err(|e| e.to_string())?;
            Ok((
                service.notes().map_err(|e| e.to_string())?,
                service.state().map_err(|e| e.to_string())?,
            ))
        });
        self.run("saving the note", cx, work, |this, (notes, state), cx| {
            this.composer = None;
            this.anchor = None;
            cx.emit(ModelEvent::Select(None));
            this.set_notes(notes, state, cx);
        });
    }

    pub fn note_action(&mut self, id: NoteId, action: NoteAction, cx: &mut Context<Self>) {
        let Some(review) = self.review.as_ref() else {
            return;
        };
        let open = review
            .notes
            .iter()
            .find(|n| n.id == id)
            .is_some_and(Note::is_open);
        let service = review.notes_service().clone();
        let work: Work<(Vec<Note>, ReviewState)> = Box::new(move || {
            let result = match action {
                NoteAction::ResolveOrReopen if open => service.resolve(&id).map(drop),
                NoteAction::ResolveOrReopen => service.reopen(&id).map(drop),
                NoteAction::Dismiss => service.dismiss(&id).map(drop),
                NoteAction::Delete => service.delete(&id),
            };
            result.map_err(|e| e.to_string())?;
            Ok((
                service.notes().map_err(|e| e.to_string())?,
                service.state().map_err(|e| e.to_string())?,
            ))
        });
        self.run("saving", cx, work, |this, (notes, state), cx| {
            this.set_notes(notes, state, cx);
        });
    }

    /// The note on the focused line, else the nearest one in this file.
    pub fn note_near_cursor(&self) -> Option<NoteId> {
        let notes = self.file_notes();
        let cursor = self.cursor;
        notes
            .iter()
            .min_by_key(|note| match cursor {
                Some(at) => {
                    let side_penalty = if note.anchor.side == at.side { 0 } else { 1 };
                    let distance =
                        if (note.anchor.line..=note.anchor.last_line()).contains(&at.line) {
                            0
                        } else {
                            note.anchor.line.abs_diff(at.line)
                        };
                    (distance, side_penalty)
                }
                None => (note.anchor.line, 0),
            })
            .map(|note| note.id.clone())
    }

    fn first_change(&self) -> Option<LinePos> {
        let diff = self.diff.as_ref()?;
        let at = diff.change_starts.first().copied().unwrap_or(0);
        diff.positions.get(at).copied()
    }

    fn cursor_index(&self) -> Option<usize> {
        let diff = self.diff.as_ref()?;
        cursor::index_of(&diff.positions, self.cursor?)
    }

    fn focus_line(&mut self, at: LinePos, extend: bool, cx: &mut Context<Self>) {
        if extend {
            self.anchor.get_or_insert(self.cursor.unwrap_or(at));
        } else {
            self.anchor = None;
        }
        self.cursor = Some(at);
        let selection = match self.anchor {
            Some(anchor) => self.in_display_order(anchor, at),
            None => (at, at),
        };
        cx.emit(ModelEvent::Select(Some(selection)));
        cx.emit(ModelEvent::ScrollTo(at));
        cx.notify();
    }

    fn in_display_order(&self, a: LinePos, b: LinePos) -> (LinePos, LinePos) {
        let index = |at| {
            self.diff
                .as_ref()
                .and_then(|diff| cursor::index_of(&diff.positions, at))
        };
        if index(a) <= index(b) { (a, b) } else { (b, a) }
    }

    pub fn set_cursor(&mut self, at: LinePos, cx: &mut Context<Self>) {
        self.anchor = None;
        self.cursor = Some(at);
        cx.notify();
    }

    pub fn move_line(&mut self, delta: isize, extend: bool, cx: &mut Context<Self>) {
        let Some(diff) = self.diff.as_ref() else {
            return;
        };
        if diff.positions.is_empty() {
            return;
        }
        let last = diff.positions.len() - 1;
        let next = match self.cursor_index() {
            Some(at) => at.saturating_add_signed(delta).min(last),
            None if delta >= 0 => 0,
            None => last,
        };
        let at = diff.positions[next];
        self.focus_line(at, extend, cx);
    }

    pub fn clear_selection(&mut self, cx: &mut Context<Self>) {
        if self.composer.is_some() {
            self.composer = None;
        }
        self.anchor = None;
        cx.emit(ModelEvent::Select(None));
        cx.notify();
    }

    /// `then_files`: past the last change, go on to the next unviewed file (n / p).
    pub fn step_change(&mut self, forward: bool, then_files: bool, cx: &mut Context<Self>) {
        let target = self.diff.as_ref().and_then(|diff| {
            let at = cursor::step_to(&diff.change_starts, self.cursor_index(), forward)?;
            diff.positions.get(at).copied()
        });
        match target {
            Some(at) => self.focus_line(at, false, cx),
            None if then_files => {
                if !self.step_file(forward, true, cx) {
                    self.say("no more unviewed files", cx);
                }
            }
            None => self.say("no more changes in this file", cx),
        }
    }

    pub fn step_note(&mut self, forward: bool, cx: &mut Context<Self>) {
        let Some(diff) = self.diff.as_ref() else {
            return;
        };
        let mut targets: Vec<usize> = self
            .file_notes()
            .iter()
            .filter(|note| !note.anchor_lost)
            .filter_map(|note| {
                cursor::index_of(
                    &diff.positions,
                    LinePos {
                        side: note.anchor.side,
                        line: note.anchor.line,
                    },
                )
            })
            .collect();
        targets.sort_unstable();
        targets.dedup();
        match cursor::step_to(&targets, self.cursor_index(), forward)
            .and_then(|at| diff.positions.get(at).copied())
        {
            Some(at) => self.focus_line(at, false, cx),
            None => self.say("no more notes in this file", cx),
        }
    }

    pub fn expand_all(&mut self, cx: &mut Context<Self>) {
        cx.emit(ModelEvent::ExpandAll);
    }

    pub fn notes_list(&self) -> Vec<&Note> {
        let Some(review) = &self.review else {
            return Vec::new();
        };
        let mut notes: Vec<&Note> = review
            .notes
            .iter()
            .filter(|note| self.notes_filter.matches(note))
            .collect();
        notes.sort_by(|a, b| ducky_review::summary::compare_notes(a, b));
        notes
    }

    pub fn jump_to_note(&mut self, id: &NoteId, cx: &mut Context<Self>) {
        let Some(note) = self
            .review
            .as_ref()
            .and_then(|r| r.notes.iter().find(|n| n.id == *id))
        else {
            return;
        };
        let at = LinePos {
            side: note.anchor.side,
            line: note.anchor.line,
        };
        let path = note.path.clone();
        let commit = note.commit.clone();
        self.changed_notes.remove(id);
        if let Some(mode) = self.mode_showing(&path, commit.as_deref()) {
            self.cursor = Some(at);
            self.selected = Some(path);
            self.set_review_mode(mode, cx);
            return;
        }
        if self.pane == Pane::Edit && self.selected.as_deref() == Some(&path) {
            if at.side == Side::New {
                cx.emit(ModelEvent::EditorGoto(at.line));
                return;
            }
            self.pane = Pane::Diff;
        }
        if self.selected.as_deref() == Some(&path) {
            self.focus_line(at, false, cx);
        } else {
            self.cursor = Some(at);
            self.load_diff(path, cx);
        }
    }
}

impl ReviewModel {
    /// A mode that shows the note: its commit for a pinned one, All changes when this view
    /// leaves the file out. `None` when the current view already shows it.
    fn mode_showing(&self, path: &str, commit: Option<&str>) -> Option<ReviewMode> {
        let review = self.review.as_ref()?;
        if let Some(sha) = commit {
            if matches!(&self.mode, ReviewMode::Commits { to, .. } if to == sha) {
                return None;
            }
            let index = review.commits.iter().position(|c| c.sha == sha)?;
            return ReviewMode::commits(
                ducky_review::commit_range::CommitRange::single(index),
                &review.commits,
            );
        }
        let listed = self.visible.iter().any(|f| f.path() == path);
        (!listed).then_some(ReviewMode::All)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteAction {
    ResolveOrReopen,
    Dismiss,
    Delete,
}
