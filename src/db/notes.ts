import type { NoteUpdate } from '../review/reanchor'
import type { RubberduckDb } from './db'
import type { Note, NoteAnchor, NoteSeverity, NoteStatus } from './schema'

export interface NewNote {
  sessionId: string
  path: string
  anchor: NoteAnchor
  body: string
  severity: NoteSeverity
  /** Set for notes kept on a commit's lines (see review/viewNotes.ts). */
  commit?: string
}

export async function addNote(db: RubberduckDb, input: NewNote): Promise<string> {
  const now = Date.now()
  return db.notes.add({ ...input, status: 'open', source: 'me', createdAt: now, updatedAt: now }) as Promise<string>
}

export async function editNote(db: RubberduckDb, id: string, changes: Pick<Note, 'body' | 'severity'>): Promise<void> {
  await db.notes.update(id, { ...changes, updatedAt: Date.now() })
}

export async function setNoteStatus(db: RubberduckDb, id: string, status: NoteStatus): Promise<void> {
  await db.notes.update(id, { status, updatedAt: Date.now() })
}

export async function deleteNote(db: RubberduckDb, id: string): Promise<void> {
  await db.notes.delete(id)
}

export function sessionNotes(db: RubberduckDb, sessionId: string): Promise<Note[]> {
  return db.notes.where({ sessionId }).toArray()
}

export async function applyReanchoring(db: RubberduckDb, updates: NoteUpdate[]): Promise<void> {
  if (updates.length === 0) return
  await db.notes.bulkUpdate(updates.map(({ id, anchor, anchorLost }) => ({ key: id, changes: { anchor, anchorLost } })))
}
