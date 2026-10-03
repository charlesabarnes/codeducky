import type { Note } from '../db/schema'

export function carryOverNotes(previous: readonly Note[], sessionId: string, now: number): Note[] {
  return previous
    .filter((note) => note.status === "open" && note.id !== undefined && !note.anchorLost)
    .map((note) => {
      const copy: Note = { ...note, sessionId, carriedFrom: note.id, updatedAt: now }
      delete copy.id
      delete copy.github
      return copy
    })
}
