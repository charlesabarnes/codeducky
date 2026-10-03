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

export type KeyGroup = 'Navigation' | 'Notes' | 'View' | 'Editor' | 'General'
export const GROUP_ORDER: readonly KeyGroup[] = ['Navigation', 'Notes', 'View', 'Editor', 'General']

export interface KeyBinding {
  id: string
  keys: readonly string[]
  label: string
  group: KeyGroup
  /** Fires on auto-repeat while the key is held. */
  repeat?: boolean
  /** Listed in help but handled locally (the note editor); never dispatched. */
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

  { id: 'note.comment', keys: ['c'], label: 'Comment on the focused line', group: 'Notes' },
  { id: 'note.edit', keys: ['e'], label: 'Edit the note at or near the focus', group: 'Notes' },
  { id: 'note.resolve', keys: ['r'], label: 'Resolve or reopen the note at or near the focus', group: 'Notes' },
  { id: 'note.accept', keys: ['a'], label: 'Accept the suggestion at or near the focus', group: 'Notes' },
  { id: 'note.dismiss', keys: ['d'], label: 'Dismiss the suggestion at or near the focus', group: 'Notes' },

  { id: 'file.viewed', keys: ['v'], label: 'Toggle viewed, then go to the next unviewed file', group: 'View' },
  { id: 'view.mode', keys: ['s'], label: 'Switch split and unified', group: 'View' },
  { id: 'view.whitespace', keys: ['w'], label: 'Hide or show whitespace changes', group: 'View' },
  { id: 'files.filter', keys: ['/'], label: 'Filter files', group: 'View' },
  { id: 'tab.files', keys: ['g f'], label: 'Files tab', group: 'View' },
  { id: 'tab.notes', keys: ['g n'], label: 'Notes tab', group: 'View' },
  { id: 'tab.checklists', keys: ['g c'], label: 'Checklists tab', group: 'View' },

  { id: 'editor.save', keys: ['mod+Enter'], label: 'Save the note', group: 'Editor', docOnly: true, shownWith: 'note.comment' },
  { id: 'editor.cancel', keys: ['Escape'], label: 'Cancel the note, or leave a text field', group: 'Editor', docOnly: true, shownWith: 'note.comment' },

  { id: 'help', keys: ['?'], label: 'Show keyboard shortcuts', group: 'General' },
  { id: 'escape', keys: ['Escape'], label: 'Leave the text field', group: 'General', hidden: true },
] as const satisfies readonly KeyBinding[]

export type ShortcutId = (typeof KEYMAP)[number]['id']

export const BINDINGS: ReadonlyMap<string, KeyBinding> = new Map(KEYMAP.map((binding) => [binding.id, binding]))

/** Tokens that still work while typing in a field. */
export const ALWAYS_ON = new Set(['Escape', 'mod+Enter'])

export function parseSequence(keys: string): string[] {
  return keys.split(' ').filter(Boolean)
}
