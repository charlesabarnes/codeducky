import type { Text } from '@codemirror/state'

/** The document at one moment: its text to save, and the version to mark saved once that worked. */
export interface EditorSnapshot {
  doc: Text
  text: string
}

/** What the pane can do to the lazily loaded editor. */
export interface EditorController {
  snapshot(): EditorSnapshot
  markSaved(doc: Text): void
  /** Replaces the whole text (revert, reload) as one undoable change, and takes it as saved. */
  replace(text: string): void
  focus(): void
}
