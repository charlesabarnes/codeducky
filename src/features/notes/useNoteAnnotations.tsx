import { useMemo, useState } from 'react'
import { db } from '../../db/db'
import { addNote } from '../../db/notes'
import type { Note, NoteSide } from '../../db/schema'
import type { LineAnnotations } from '../../diff/DiffTable'
import { lineKey } from '../../diff/hunks'
import { createAnchor } from '../../review/anchor'
import type { NumberedLine } from '../../review/lines'
import { NoteCard } from './NoteCard'
import { NoteEditor } from './NoteEditor'

interface Options {
  sessionId: number
  path: string
  notes: Note[]
  lines: Record<NoteSide, NumberedLine[] | null>
  focusedId: number | null
}

export function useNoteAnnotations({ sessionId, path, notes, lines, focusedId }: Options): LineAnnotations {
  const [draft, setDraft] = useState<{ path: string; key: string } | null>(null)
  const draftKey = draft?.path === path ? draft.key : null

  const byLine = useMemo(() => {
    const map = new Map<string, Note[]>()
    for (const note of notes) {
      if (note.anchorLost) continue
      const key = lineKey(note.anchor.side, note.anchor.line)
      map.set(key, [...(map.get(key) ?? []), note])
    }
    return map
  }, [notes])

  const pinned = useMemo(() => new Set(draftKey ? [...byLine.keys(), draftKey] : byLine.keys()), [byLine, draftKey])

  return {
    pinned,
    onSelect: (side, line) => setDraft({ path, key: lineKey(side, line) }),
    render: (side, line) => {
      const key = lineKey(side, line)
      const lineNotes = byLine.get(key)
      const editing = draftKey === key
      if (!lineNotes && !editing) return null
      return (
        <div className={`line-notes side-${side}`} key={key}>
          {lineNotes?.map((note) => <NoteCard key={note.id} note={note} focused={note.id === focusedId} />)}
          {editing && (
            <NoteEditor
              submitLabel="Add note"
              onCancel={() => setDraft(null)}
              onSubmit={async ({ body, severity }) => {
                const sideLines = lines[side]
                if (!sideLines) return
                await addNote(db, { sessionId, path, anchor: createAnchor(sideLines, line, side), body, severity })
                setDraft(null)
              }}
            />
          )}
        </div>
      )
    },
  }
}
