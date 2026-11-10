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
    ]
);

/// Single-key shortcuts must not fire while typing in a field.
pub const REVIEW: &str = "Review && !Input";
pub const NOTE_EDITOR: &str = "NoteEditor";

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
pub const SAVE_KEYS: &str = secondary!("enter");

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
        KeyBinding::new(secondary!("enter"), SaveNote, Some(NOTE_EDITOR)),
        KeyBinding::new("escape", CancelNote, Some(NOTE_EDITOR)),
    ]);
}
