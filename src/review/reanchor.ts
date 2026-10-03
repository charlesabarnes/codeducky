import type { Note, NoteAnchor, NoteSide } from '../db/schema'
import { createAnchor } from './anchor'
import type { NumberedLine } from './lines'
import { matchAnchor } from './match'

export interface Reanchored {
  anchor: NoteAnchor
  anchorLost: boolean
}

export function reanchor(anchor: NoteAnchor, lines: readonly NumberedLine[] | null): Reanchored {
  const match = lines ? matchAnchor(anchor, lines) : null
  if (!lines || !match) return { anchor, anchorLost: true }
  return { anchor: createAnchor(lines, match.line, anchor.side), anchorLost: false }
}

export type LineSource = (path: string, side: NoteSide) => readonly NumberedLine[] | null

export interface NoteUpdate extends Reanchored {
  id: string
}

const sameAnchor = (a: NoteAnchor, b: NoteAnchor) =>
  a.line === b.line &&
  a.side === b.side &&
  a.text === b.text &&
  a.before.join('\n') === b.before.join('\n') &&
  a.after.join('\n') === b.after.join('\n')

export function reanchorNotes(notes: readonly Note[], source: LineSource): NoteUpdate[] {
  const updates: NoteUpdate[] = []
  for (const note of notes) {
    if (note.id === undefined) continue
    const result = reanchor(note.anchor, source(note.path, note.anchor.side))
    if (result.anchorLost === Boolean(note.anchorLost) && sameAnchor(result.anchor, note.anchor)) continue
    updates.push({ id: note.id, ...result })
  }
  return updates
}
