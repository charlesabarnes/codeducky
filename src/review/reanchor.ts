import type { Note, NoteAnchor, NoteSide } from '../db/schema'
import { createAnchor, lastLine } from './anchor'
import { indexOfLine, type NumberedLine } from './lines'
import { matchAnchor } from './match'

export interface Reanchored {
  anchor: NoteAnchor
  anchorLost: boolean
}

/** A note added over MCP without the line's text: only the line number is known. */
export const isLineOnly = (anchor: NoteAnchor) =>
  anchor.text === '' && anchor.before.length === 0 && anchor.after.length === 0 && !anchor.rangeText?.length

export function reanchor(anchor: NoteAnchor, lines: readonly NumberedLine[] | null): Reanchored {
  if (lines && isLineOnly(anchor) && indexOfLine(lines, anchor.line) >= 0 && indexOfLine(lines, lastLine(anchor)) >= 0) {
    return { anchor: createAnchor(lines, anchor.line, anchor.side, lastLine(anchor)), anchorLost: false }
  }
  const match = lines ? matchAnchor(anchor, lines) : null
  if (!lines || !match) return { anchor, anchorLost: true }
  return { anchor: createAnchor(lines, match.line, anchor.side, match.endLine), anchorLost: false }
}

export type LineSource = (path: string, side: NoteSide) => readonly NumberedLine[] | null

export interface NoteUpdate extends Reanchored {
  id: string
}

const sameAnchor = (a: NoteAnchor, b: NoteAnchor) =>
  a.line === b.line &&
  lastLine(a) === lastLine(b) &&
  a.side === b.side &&
  a.text === b.text &&
  a.before.join('\n') === b.before.join('\n') &&
  a.after.join('\n') === b.after.join('\n') &&
  (a.rangeText ?? []).join('\n') === (b.rangeText ?? []).join('\n')

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
