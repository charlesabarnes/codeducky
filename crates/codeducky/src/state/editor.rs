//! One working-tree file open in the editor: reading it, saving it through the repo's host
//! (so it works on other machines too), and noticing when it changed on disk meanwhile.

use ducky_git::Repo;
use ducky_session::{EditBuffer, SaveOutcome, ViewEntry, open_for_edit, save_edit};
use gpui_kit::*;

pub enum EditorEvent {
    /// The buffer was (re)read from disk; the editor takes its text.
    Loaded,
    Saved,
}

/// The file changed on disk since the editor read it, and a save was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Conflict {
    pub deleted: bool,
}

pub struct EditorModel {
    pub path: String,
    pub buffer: Option<EditBuffer>,
    /// Why the file cannot be edited, or why reading or saving it failed.
    pub problem: Option<String>,
    pub dirty: bool,
    pub conflict: Option<Conflict>,
    pub busy: Option<&'static str>,
    repo: Repo,
    entry: ViewEntry,
}

impl EventEmitter<EditorEvent> for EditorModel {}

impl EditorModel {
    pub fn new(repo: Repo, entry: ViewEntry, cx: &mut Context<Self>) -> Self {
        let mut this = Self {
            path: entry.file.path().to_owned(),
            buffer: None,
            problem: None,
            dirty: false,
            conflict: None,
            busy: None,
            repo,
            entry,
        };
        this.load(cx);
        this
    }

    /// Reads the file again, dropping unsaved edits.
    pub fn load(&mut self, cx: &mut Context<Self>) {
        let (repo, entry) = (self.repo.clone(), self.entry.clone());
        self.busy = Some("reading");
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { open_for_edit(&repo, &entry) })
                .await;
            this.update(cx, |this, cx| {
                this.busy = None;
                this.conflict = None;
                match result {
                    Ok(Ok(buffer)) => {
                        this.buffer = Some(buffer);
                        this.problem = None;
                        this.dirty = false;
                        cx.emit(EditorEvent::Loaded);
                    }
                    Ok(Err(reason)) => this.problem = Some(capitalized(&reason.to_string())),
                    Err(error) => this.problem = Some(format!("Could not read the file: {error}")),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn set_text(&mut self, text: &str, cx: &mut Context<Self>) {
        let dirty = self.buffer.as_ref().is_some_and(|b| b.text != text);
        if dirty != self.dirty {
            self.dirty = dirty;
            cx.notify();
        }
    }

    /// `force` writes over a file that changed on disk.
    pub fn save(&mut self, text: String, force: bool, cx: &mut Context<Self>) {
        let Some(buffer) = self.buffer.clone() else {
            return;
        };
        if self.busy.is_some() {
            return;
        }
        let repo = self.repo.clone();
        self.busy = Some("saving");
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { save_edit(&repo, &buffer, &text, force) })
                .await;
            this.update(cx, |this, cx| {
                this.busy = None;
                match result {
                    Ok(SaveOutcome::Saved(buffer)) => {
                        this.buffer = Some(buffer);
                        this.dirty = false;
                        this.conflict = None;
                        this.problem = None;
                        cx.emit(EditorEvent::Saved);
                    }
                    Ok(SaveOutcome::Conflict { deleted }) => {
                        this.conflict = Some(Conflict { deleted });
                    }
                    Err(error) => this.problem = Some(format!("Could not save: {error}")),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn keep_editing(&mut self, cx: &mut Context<Self>) {
        self.conflict = None;
        cx.notify();
    }
}

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}
