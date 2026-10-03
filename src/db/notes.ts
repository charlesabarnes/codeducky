import type { NoteUpdate } from '../review/reanchor'
import type { SkelbertDb } from './db'
import type { Note, NoteAnchor, NoteSeverity, NoteStatus } from './schema'

export interface NewNote {
  sessionId: number
  path: string
  anchor: NoteAnchor
  body: string
  severity: NoteSeverity
}

export async function addNote(db: SkelbertDb, input: NewNote): Promise<number> {
  const now = Date.now()
  return db.notes.add({ ...input, status: 'open', source: 'me', createdAt: now, updatedAt: now }) as Promise<number>
}

export async function editNote(db: SkelbertDb, id: number, changes: Pick<Note, 'body' | 'severity'>): Promise<void> {
  await db.notes.update(id, { ...changes, updatedAt: Date.now() })
}

export async function setNoteStatus(db: SkelbertDb, id: number, status: NoteStatus): Promise<void> {
  await db.notes.update(id, { status, updatedAt: Date.now() })
}

export async function deleteNote(db: SkelbertDb, id: number): Promise<void> {
  await db.notes.delete(id)
}

export function sessionNotes(db: SkelbertDb, sessionId: number): Promise<Note[]> {
  return db.notes.where({ sessionId }).toArray()
}

export async function applyReanchoring(db: SkelbertDb, updates: NoteUpdate[]): Promise<void> {
  if (updates.length === 0) return
  await db.notes.bulkUpdate(updates.map(({ id, anchor, anchorLost }) => ({ key: id, changes: { anchor, anchorLost } })))
}
