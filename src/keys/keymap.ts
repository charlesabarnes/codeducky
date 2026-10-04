/**
 * The single source of truth for every shortcut. Handlers attach to these ids at runtime
 * (see useShortcuts); the help overlay is generated from this table.
 *
 * Keys are sequences of tokens separated by spaces ("g n"). A token is a printable key as
 * produced by eventToken ("j", "J" for Shift+J, "?", "]"), or a named key ("Escape",
 * "ArrowLeft", "mod+Enter").
 */

export type KeyScope = 'global' | 'session' | 'file' | 'diff' | 'split'

/** Higher wins when two active registrations claim the same key. */
export const SCOPE_PRIORITY: Record<KeyScope, number> = { global: 0, session: 1, file: 2, diff: 3, split: 4 }

export type KeyGroup = 'Navigation' | 'Notes' | 'Pull request' | 'View' | 'Note editor' | 'File editor' | 'Inbox' | 'General'
export const GROUP_ORDER: readonly KeyGroup[] = ['Navigation', 'Notes', 'Pull request', 'View', 'Note editor', 'File editor', 'Inbox', 'General']

export interface KeyBinding {
  id: string
  keys: readonly string[]
  label: string
  group: KeyGroup
  /** Fires on auto-repeat while the key is held. */
  repeat?: boolean
  /** Listed in help but handled locally (the note editor, the file editor); never dispatched. */
  docOnly?: boolean
  /** For docOnly entries: list them whenever this binding is active. */
  shownWith?: string
  /** Dispatched but not listed in help. */
  hidden?: boolean
}

export const KEYMAP = [
  { id: 'line.next', keys: ['j'], label: 'Next line', group: 'Navigation', repeat: true },
  { id: 'line.prev', keys: ['k'], label: 'Previous line', group: 'Navigation', repeat: true },
  { id: 'change.next', keys: ['J'], label: 'Next change in this file', group: 'Navigation', repeat: true },
  { id: 'change.prev', keys: ['K'], label: 'Previous change in this file', group: 'Navigation', repeat: true },
  { id: 'hunk.next', keys: ['n'], label: 'Next change, then the next unviewed file', group: 'Navigation', repeat: true },
  { id: 'hunk.prev', keys: ['p'], label: 'Previous change, then the previous unviewed file', group: 'Navigation', repeat: true },
  { id: 'file.next', keys: [']'], label: 'Next file', group: 'Navigation', repeat: true },
  { id: 'file.prev', keys: ['['], label: 'Previous file', group: 'Navigation', repeat: true },
  { id: 'note.next', keys: ['N'], label: 'Next note in this file', group: 'Navigation', repeat: true },
  { id: 'note.prev', keys: ['P'], label: 'Previous note in this file', group: 'Navigation', repeat: true },
  { id: 'side.old', keys: ['h', 'ArrowLeft'], label: 'Left side (base) in split view', group: 'Navigation' },
  { id: 'side.new', keys: ['l', 'ArrowRight'], label: 'Right side (changes) in split view', group: 'Navigation' },
  { id: 'gap.expand', keys: ['x'], label: 'Expand collapsed lines next to the focus', group: 'Navigation' },
  // `]c`/`[c` would never fire: `]` and `[` already step files, and a complete match wins over a longer sequence.
  { id: 'commit.next', keys: ['}'], label: 'Next commit (from All changes, the first one)', group: 'Navigation', repeat: true },
  { id: 'commit.prev', keys: ['{'], label: 'Previous commit (before the first, All changes)', group: 'Navigation', repeat: true },

  { id: 'note.comment', keys: ['c'], label: 'Comment on the focused line', group: 'Notes' },
  { id: 'note.edit', keys: ['e'], label: 'Edit the note at or near the focus', group: 'Notes' },
  { id: 'note.resolve', keys: ['r'], label: 'Resolve or reopen the note at or near the focus', group: 'Notes' },
  { id: 'note.accept', keys: ['a'], label: 'Accept the suggestion at or near the focus', group: 'Notes' },
  { id: 'note.dismiss', keys: ['d'], label: 'Dismiss the suggestion at or near the focus', group: 'Notes' },

  { id: 'thread.next', keys: ['t'], label: 'Next review thread', group: 'Pull request', repeat: true },
  { id: 'thread.prev', keys: ['T'], label: 'Previous review thread', group: 'Pull request', repeat: true },
  { id: 'thread.reply', keys: ['R'], label: 'Reply to the current thread', group: 'Pull request' },
  { id: 'thread.resolve', keys: ['X'], label: 'Resolve or unresolve the current thread', group: 'Pull request' },
  { id: 'tab.conversation', keys: ['g d'], label: 'Conversation tab', group: 'Pull request' },

  { id: 'file.viewed', keys: ['v'], label: 'Toggle viewed, then go to the next unviewed file', group: 'View' },
  { id: 'view.mode', keys: ['s'], label: 'Switch split and unified', group: 'View' },
  { id: 'view.whitespace', keys: ['w'], label: 'Hide or show whitespace changes', group: 'View' },
  { id: 'files.filter', keys: ['/'], label: 'Filter files', group: 'View' },
  { id: 'mode.since', keys: ['L'], label: 'Since last look: only what changed since you viewed each file', group: 'View' },
  { id: 'mode.all', keys: ['g a'], label: 'All changes on the branch', group: 'View' },
  { id: 'tab.files', keys: ['g f'], label: 'Files tab', group: 'View' },
  { id: 'tab.notes', keys: ['g n'], label: 'Notes tab', group: 'View' },
  { id: 'tab.checklists', keys: ['g c'], label: 'Checklists tab', group: 'View' },

  { id: 'editor.save', keys: ['mod+Enter'], label: 'Save the note', group: 'Note editor', docOnly: true, shownWith: 'note.comment' },
  { id: 'editor.cancel', keys: ['Escape'], label: 'Cancel the note, or leave a text field', group: 'Note editor', docOnly: true, shownWith: 'note.comment' },

  // `e` edits notes, so the file editor takes Shift+E. Inside the editor every key is the editor's own.
  { id: 'file.edit', keys: ['E'], label: 'Switch between the diff and the file editor', group: 'File editor' },
  { id: 'file.save', keys: ['mod+s'], label: 'Save the file (commits to the branch in a pull request)', group: 'File editor' },
  { id: 'file.find', keys: ['mod+f'], label: 'Find and replace in the file', group: 'File editor', docOnly: true, shownWith: 'file.save' },
  { id: 'file.undo', keys: ['mod+z'], label: 'Undo', group: 'File editor', docOnly: true, shownWith: 'file.save' },
  { id: 'file.redo', keys: ['mod+shift+z'], label: 'Redo', group: 'File editor', docOnly: true, shownWith: 'file.save' },
  { id: 'file.indent', keys: ['Tab'], label: 'Indent the line or selection', group: 'File editor', docOnly: true, shownWith: 'file.save' },
  { id: 'file.outdent', keys: ['shift+Tab'], label: 'Outdent the line or selection', group: 'File editor', docOnly: true, shownWith: 'file.save' },
  { id: 'file.leave', keys: ['Escape Tab'], label: 'Move focus out of the editor', group: 'File editor', docOnly: true, shownWith: 'file.save' },

  { id: 'inbox.next', keys: ['j'], label: 'Next pull request', group: 'Inbox', repeat: true },
  { id: 'inbox.prev', keys: ['k'], label: 'Previous pull request', group: 'Inbox', repeat: true },
  { id: 'inbox.open', keys: ['o'], label: 'Open a pull request by URL or owner/repo#123', group: 'Inbox' },

  { id: 'nav.inbox', keys: ['g i'], label: 'Go to the inbox', group: 'General' },
  { id: 'help', keys: ['?'], label: 'Show keyboard shortcuts', group: 'General' },
  { id: 'escape', keys: ['Escape'], label: 'Leave the text field', group: 'General', hidden: true },
] as const satisfies readonly KeyBinding[]

export type ShortcutId = (typeof KEYMAP)[number]['id']

export const BINDINGS: ReadonlyMap<string, KeyBinding> = new Map(KEYMAP.map((binding) => [binding.id, binding]))

/** Tokens that still work while typing in a field. */
export const ALWAYS_ON = new Set(['Escape', 'mod+Enter', 'mod+s'])

export function parseSequence(keys: string): string[] {
  return keys.split(' ').filter(Boolean)
}
