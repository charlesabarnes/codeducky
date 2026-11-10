//! Every shortcut, in the TypeScript app's GitHub/Gerrit style. The help overlay and the
//! command palette are built from [`HELP`].

use gpui_kit::*;

actions!(
    codeducky,
    [
        Quit,
        OpenRepo,
        Refresh,
        ReloadNotes,
        ToggleHelp,
        CommandPalette,
        CycleAppearance,
        CyclePalette,
        CycleDensity,
        NextLine,
        PrevLine,
        ExtendDown,
        ExtendUp,
        ClearSelection,
        NextChange,
        PrevChange,
        NextHunk,
        PrevHunk,
        NextFile,
        PrevFile,
        NextUnviewed,
        PrevUnviewed,
        NextNote,
        PrevNote,
        ExpandAll,
        Comment,
        EditNote,
        ResolveNote,
        DismissNote,
        ToggleViewed,
        ToggleMode,
        ToggleWhitespace,
        ToggleWrap,
        ToggleOrder,
        FocusFilter,
        FilesTab,
        NotesTab,
        ChangeBase,
        SaveNote,
        CancelNote,
        ToggleAgents,
        FocusTerminal,
        StartAgent,
        AskReview,
        AskFix,
        AskMessage,
        ReconnectCore,
        PickMachine,
        CloseDialog,
        SubmitDialog,
        ToggleSince,
        AllChanges,
        NextCommit,
        PrevCommit,
        CommitPicker,
        ToggleUnchanged,
        MarkReviewed,
        ChecksTab,
        ManageChecklists,
        ToggleEditor,
        SaveFile,
        RevertFile,
    ]
);

/// Single-key shortcuts must not fire while typing in a field or a terminal.
pub const REVIEW: &str = "Review && !Input && !Terminal && !Dialog";
pub const NOTE_EDITOR: &str = "NoteEditor";
pub const DIALOG: &str = "Dialog";
pub const FILE_EDITOR: &str = "FileEditor";

#[cfg(target_os = "macos")]
macro_rules! secondary {
    ($key:literal) => {
        concat!("cmd-", $key)
    };
}
#[cfg(not(target_os = "macos"))]
macro_rules! secondary {
    ($key:literal) => {
        concat!("ctrl-", $key)
    };
}

pub const REFRESH_KEYS: &str = secondary!("r");
/// Works inside the terminal too: the terminal never sees it.
pub const FOCUS_TERMINAL_KEYS: &str = "ctrl-`";
#[cfg(target_os = "macos")]
pub const AGENTS_KEYS: &str = "cmd-j";
/// ctrl-j is a terminal's newline, so not that one.
#[cfg(not(target_os = "macos"))]
pub const AGENTS_KEYS: &str = "ctrl-shift-j";
pub const SAVE_KEYS: &str = secondary!("enter");
pub const SAVE_FILE_KEYS: &str = secondary!("s");
/// Leaves the editor from inside it, where single keys type.
pub const LEAVE_EDITOR_KEYS: &str = secondary!("shift-e");

pub struct Shortcut {
    pub keys: &'static str,
    pub label: &'static str,
    pub group: &'static str,
}

const fn s(keys: &'static str, label: &'static str, group: &'static str) -> Shortcut {
    Shortcut { keys, label, group }
}

pub const HELP: &[Shortcut] = &[
    s("j / k", "Next / previous line", "Navigation"),
    s(
        "shift-↓ / shift-↑",
        "Extend the line selection",
        "Navigation",
    ),
    s("J / K", "Next / previous change in this file", "Navigation"),
    s(
        "n / p",
        "Next / previous change, then the next unviewed file",
        "Navigation",
    ),
    s("] / [", "Next / previous file", "Navigation"),
    s("u / U", "Next / previous unviewed file", "Navigation"),
    s("N / P", "Next / previous note in this file", "Navigation"),
    s("x", "Expand all collapsed lines", "Navigation"),
    s(
        "}",
        "Next commit (from All changes, the first one)",
        "Navigation",
    ),
    s(
        "{",
        "Previous commit (before the first, All changes)",
        "Navigation",
    ),
    s(
        "c",
        "Comment on the focused line or the selected lines",
        "Notes",
    ),
    s("e", "Edit the note at or near the focus", "Notes"),
    s(
        "r",
        "Resolve or reopen the note at or near the focus",
        "Notes",
    ),
    s("d", "Dismiss the note at or near the focus", "Notes"),
    s(secondary!("enter"), "Save the note", "Note editor"),
    s("escape", "Cancel the note", "Note editor"),
    s(
        "v",
        "Toggle viewed, then go to the next unviewed file",
        "View",
    ),
    s("s", "Switch split and unified", "View"),
    s("w", "Hide or show whitespace changes", "View"),
    s("z", "Wrap long lines", "View"),
    s("o", "Order files by folder or by risk", "View"),
    s("/", "Filter files", "View"),
    s("g f / g n", "Files tab / notes tab", "View"),
    s("b", "Change the base", "View"),
    s(
        "L",
        "Since last look: only what changed since you viewed each file",
        "View",
    ),
    s("g a", "All changes on the branch", "View"),
    s("g k", "Pick a commit or a range", "View"),
    s(
        "g u",
        "Show or hide files unchanged since your last look",
        "View",
    ),
    s(
        "V",
        "Mark the review reviewed: since last look starts here",
        "View",
    ),
    s("g c", "Checklists tab", "View"),
    s(
        "E",
        "Switch between the diff and the file editor",
        "File editor",
    ),
    s(SAVE_FILE_KEYS, "Save the file", "File editor"),
    s(
        LEAVE_EDITOR_KEYS,
        "Back to the diff, at the editor's line",
        "File editor",
    ),
    s(
        secondary!("f"),
        "Find and replace in the file",
        "File editor",
    ),
    s(secondary!("z"), "Undo", "File editor"),
    s(secondary!("shift-z"), "Redo", "File editor"),
    s(AGENTS_KEYS, "Show or hide the agents panel", "Agents"),
    s(
        FOCUS_TERMINAL_KEYS,
        "Move between the diff and the terminal",
        "Agents",
    ),
    s("a n", "Start an agent", "Agents"),
    s("a r", "Ask an agent to review the branch", "Agents"),
    s(
        "a f",
        "Ask an agent to fix the open (or checked) notes",
        "Agents",
    ),
    s("a m", "Send an agent a message", "Agents"),
    s(secondary!("r"), "Refresh the review", "General"),
    s(
        secondary!("shift-r"),
        "Reload notes (after an agent edited them)",
        "General",
    ),
    s(secondary!("o"), "Open a repository", "General"),
    s(secondary!("shift-p"), "Command palette", "General"),
    s("?", "Show keyboard shortcuts", "General"),
];

pub fn bind(cx: &mut App) {
    let review = Some(REVIEW);
    cx.bind_keys([
        KeyBinding::new(secondary!("q"), Quit, None),
        KeyBinding::new(secondary!("o"), OpenRepo, None),
        KeyBinding::new(secondary!("r"), Refresh, None),
        KeyBinding::new(secondary!("shift-r"), ReloadNotes, None),
        KeyBinding::new(secondary!("shift-p"), CommandPalette, None),
        KeyBinding::new("?", ToggleHelp, review),
        KeyBinding::new("j", NextLine, review),
        KeyBinding::new("k", PrevLine, review),
        KeyBinding::new("down", NextLine, review),
        KeyBinding::new("up", PrevLine, review),
        KeyBinding::new("shift-down", ExtendDown, review),
        KeyBinding::new("shift-up", ExtendUp, review),
        KeyBinding::new("escape", ClearSelection, review),
        KeyBinding::new("shift-j", NextChange, review),
        KeyBinding::new("shift-k", PrevChange, review),
        KeyBinding::new("n", NextHunk, review),
        KeyBinding::new("p", PrevHunk, review),
        KeyBinding::new("]", NextFile, review),
        KeyBinding::new("[", PrevFile, review),
        KeyBinding::new("u", NextUnviewed, review),
        KeyBinding::new("shift-u", PrevUnviewed, review),
        KeyBinding::new("shift-n", NextNote, review),
        KeyBinding::new("shift-p", PrevNote, review),
        KeyBinding::new("x", ExpandAll, review),
        KeyBinding::new("c", Comment, review),
        KeyBinding::new("e", EditNote, review),
        KeyBinding::new("r", ResolveNote, review),
        KeyBinding::new("d", DismissNote, review),
        KeyBinding::new("v", ToggleViewed, review),
        KeyBinding::new("s", ToggleMode, review),
        KeyBinding::new("w", ToggleWhitespace, review),
        KeyBinding::new("z", ToggleWrap, review),
        KeyBinding::new("o", ToggleOrder, review),
        KeyBinding::new("b", ChangeBase, review),
        KeyBinding::new("/", FocusFilter, review),
        KeyBinding::new("g f", FilesTab, review),
        KeyBinding::new("g n", NotesTab, review),
        KeyBinding::new(AGENTS_KEYS, ToggleAgents, None),
        KeyBinding::new(FOCUS_TERMINAL_KEYS, FocusTerminal, None),
        KeyBinding::new("a n", StartAgent, review),
        KeyBinding::new("a r", AskReview, review),
        KeyBinding::new("a f", AskFix, review),
        KeyBinding::new("a m", AskMessage, review),
        KeyBinding::new(secondary!("enter"), SaveNote, Some(NOTE_EDITOR)),
        KeyBinding::new("escape", CancelNote, Some(NOTE_EDITOR)),
        KeyBinding::new("escape", CloseDialog, Some(DIALOG)),
        KeyBinding::new(secondary!("enter"), SubmitDialog, Some(DIALOG)),
        KeyBinding::new("shift-l", ToggleSince, review),
        KeyBinding::new("g a", AllChanges, review),
        KeyBinding::new("}", NextCommit, review),
        KeyBinding::new("{", PrevCommit, review),
        KeyBinding::new("g k", CommitPicker, review),
        KeyBinding::new("g u", ToggleUnchanged, review),
        KeyBinding::new("shift-v", MarkReviewed, review),
        KeyBinding::new("g c", ChecksTab, review),
        KeyBinding::new("shift-e", ToggleEditor, review),
        KeyBinding::new(LEAVE_EDITOR_KEYS, ToggleEditor, Some(FILE_EDITOR)),
        KeyBinding::new(SAVE_FILE_KEYS, SaveFile, Some(FILE_EDITOR)),
    ]);
}
