//! Moving between the diff and the editor, keeping the line in view both ways.

use ducky_review::Side;
use gpui_kit::*;

use crate::state::cursor::{LinePos, new_side_line};
use crate::state::{ModelEvent, Pane};
use crate::views::editor_pane::EditorPane;
use crate::views::workspace::Workspace;

impl Workspace {
    pub fn toggle_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match self.model.read(cx).pane {
            Pane::Diff => self.open_editor(window, cx),
            Pane::Edit => self.leave_editor(window, cx),
        }
    }

    /// Opens the selected file at the focused line (a removed line goes to the next one kept).
    pub fn open_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let model = self.model.read(cx);
        let (Some(review), Some(entry)) = (model.review.as_ref(), model.current_entry()) else {
            return;
        };
        let entry = entry.clone();
        let Some(repo) = review.repo().cloned() else {
            let text = format!(
                "cannot edit here: {}",
                ducky_session::NotEditable::NoCheckout
            );
            self.model.update(cx, |m, cx| m.fail(text, cx));
            return;
        };
        let line = match (
            model.cursor,
            model.diff.as_ref().and_then(|d| d.diff.text()),
        ) {
            (Some(at), Some(text)) => Some(new_side_line(text, at)),
            _ => None,
        };
        if let Err(reason) = ducky_session::editable(&entry) {
            let text = format!("cannot edit here: {reason}");
            self.model.update(cx, |m, cx| m.fail(text, cx));
            return;
        }
        let path = entry.file.path().to_owned();
        let reuse = self
            .editor
            .as_ref()
            .is_some_and(|editor| editor.read(cx).path(cx) == path);
        if !reuse {
            let workspace = cx.entity().downgrade();
            self.editor =
                Some(cx.new(|cx| EditorPane::new(repo, entry, line, workspace, window, cx)));
        }
        if let Some(editor) = self.editor.clone() {
            editor.update(cx, |editor, cx| {
                if reuse && let Some(line) = line {
                    editor.goto_line(line, window, cx);
                }
                editor.focus(window, cx);
            });
        }
        self.model.update(cx, |m, cx| {
            m.pane = Pane::Edit;
            m.say(format!("editing {path}"), cx);
        });
    }

    /// Back to the diff at the editor's line. An editor with unsaved edits stays alive.
    pub fn leave_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let line = self.editor.as_ref().map(|e| e.read(cx).cursor_line(cx));
        self.model.update(cx, |m, cx| {
            m.pane = Pane::Diff;
            if let Some(line) = line {
                let at = LinePos {
                    side: Side::New,
                    line,
                };
                m.cursor = Some(at);
                cx.emit(ModelEvent::Select(Some((at, at))));
                cx.emit(ModelEvent::ScrollTo(at));
            }
            cx.notify();
        });
        window.focus(&self.focus, cx);
    }

    /// After another file is selected in the editor: edit that one too, or show its diff.
    pub fn follow_selection_in_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let model = self.model.read(cx);
        if model.pane != Pane::Edit {
            return;
        }
        let same = match (&self.editor, &model.selected) {
            (Some(editor), Some(path)) => editor.read(cx).path(cx) == *path,
            _ => false,
        };
        if same {
            return;
        }
        let editable = model
            .current_entry()
            .is_some_and(|entry| ducky_session::editable(entry).is_ok());
        if editable {
            self.editor = None;
            self.open_editor(window, cx);
        } else {
            self.model.update(cx, |m, cx| {
                m.pane = Pane::Diff;
                cx.notify();
            });
        }
    }

    pub fn editor_goto(&mut self, line: u32, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(editor) = self.editor.clone() {
            editor.update(cx, |editor, cx| {
                editor.goto_line(line, window, cx);
                editor.focus(window, cx);
            });
        }
    }
}
