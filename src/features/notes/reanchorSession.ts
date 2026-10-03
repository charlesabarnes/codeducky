import { db } from '../../db/db'
import { applyReanchoring, sessionNotes } from '../../db/notes'
import type { NoteSide } from '../../db/schema'
import { gitService } from '../../git/client'
import type { FileChange, FileSide } from '../../git/types'
import { sideLines, type NumberedLine } from '../../review/lines'
import { reanchorNotes } from '../../review/reanchor'

type Sides = Record<NoteSide, NumberedLine[] | null>

const unreadable = (side: FileSide | null) => side !== null && side.kind !== 'text'

export async function reanchorSession(sessionId: string, files: FileChange[], cancelled: () => boolean): Promise<void> {
  const notes = await sessionNotes(db, sessionId)
  if (notes.length === 0) return
  const changes = new Map(files.map((file) => [file.path, file]))
  const sides = new Map<string, Sides | 'skip'>()
  for (const path of new Set(notes.map((note) => note.path))) {
    const change = changes.get(path)
    if (!change) {
      sides.set(path, { old: null, new: null })
      continue
    }
    const contents = await gitService().contents(change)
    if (cancelled()) return
    sides.set(
      path,
      unreadable(contents.old) || unreadable(contents.new)
        ? 'skip'
        : { old: sideLines(contents.old), new: sideLines(contents.new) },
    )
  }
  const readable = notes.filter((note) => sides.get(note.path) !== 'skip')
  const updates = reanchorNotes(readable, (path, side) => (sides.get(path) as Sides)[side])
  if (!cancelled()) await applyReanchoring(db, updates)
}
