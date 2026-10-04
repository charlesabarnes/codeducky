import { useMemo, useState } from 'react'
import { db } from '../../db/db'
import { addNote, setNoteStatus } from '../../db/notes'
import type { Note, NoteSide } from '../../db/schema'
import { acceptSuggestion, dismissSuggestion } from '../../db/suggestions'
import type { LineAnnotations } from '../../diff/DiffTable'
import { lineKey } from '../../diff/hunks'
import type { LineActions, NoteAction } from '../../keys/lineActions'
import { createAnchor } from '../../review/anchor'
import type { NumberedLine } from '../../review/lines'
import type { AnchorResult } from '../../review/viewNotes'
import { NoteCard } from './NoteCard'
import { NoteEditor } from './NoteEditor'

interface Options {
  sessionId: string
  path: string
  notes: Note[]
  lines: Record<NoteSide, NumberedLine[] | null>
  focusedId: string | null
  /** Where a new note on this diff is anchored; the branch-wide diff anchors on the clicked line itself. */
  anchorFor?: (side: NoteSide, line: number) => Promise<AnchorResult>
  /** Why notes cannot be made on this side of the diff, or null when they can. */
  refuseSide?: (side: NoteSide) => string | null
  /** Shown when a note cannot be made here. */
  onRefuse?: (message: string) => void
}

const ACCEPTS: Record<NoteAction, (note: Note) => boolean> = {
  edit: () => true,
  resolve: (note) => note.status === 'open' || note.status === 'resolved',
  accept: (note) => note.status === 'suggested',
  dismiss: (note) => note.status === 'suggested',
}

const summary = (note: Note) => {
  const text = note.title ?? note.body.split('\n')[0] ?? ''
  return text.length > 60 ? `${text.slice(0, 59)}…` : text
}

export function useNoteAnnotations({ sessionId, path, notes, lines, focusedId, anchorFor, refuseSide, onRefuse }: Options): LineAnnotations {
  const [draft, setDraft] = useState<{ path: string; key: string } | null>(null)
  const draftKey = draft?.path === path ? draft.key : null
  const [editingId, setEditingId] = useState<Note['id'] | null>(null)

  const byLine = useMemo(() => {
    const map = new Map<string, Note[]>()
    for (const note of notes) {
      if (note.anchorLost || note.status === 'dismissed') continue
      const key = lineKey(note.anchor.side, note.anchor.line)
      map.set(key, [...(map.get(key) ?? []), note])
    }
    return map
  }, [notes])

  const pinned = useMemo(() => new Set(draftKey ? [...byLine.keys(), draftKey] : byLine.keys()), [byLine, draftKey])

  const actions: LineActions = {
    noted: new Set(byLine.keys()),
    comment: (side, line) => {
      const refusal = refuseSide?.(side)
      if (refusal) return onRefuse?.(refusal)
      setDraft({ path, key: lineKey(side, line) })
    },
    act: (action, keys) => {
      for (const key of keys) {
        const note = byLine.get(key)?.find(ACCEPTS[action])
        if (!note || note.id === undefined) continue
        const id = note.id
        if (action === 'edit') {
          setEditingId(id)
          return { key, message: `Editing: ${summary(note)}` }
        }
        if (action === 'resolve') {
          const next = note.status === 'resolved' ? 'open' : 'resolved'
          void setNoteStatus(db, id, next)
          return { key, message: `${next === 'resolved' ? 'Resolved' : 'Reopened'}: ${summary(note)}` }
        }
        void (action === 'accept' ? acceptSuggestion(db, id) : dismissSuggestion(db, id))
        return { key, message: `${action === 'accept' ? 'Accepted' : 'Dismissed'}: ${summary(note)}` }
      }
      return null
    },
  }

  return {
    pinned,
    actions,
    onSelect: actions.comment,
    render: (side, line) => {
      const key = lineKey(side, line)
      const lineNotes = byLine.get(key)
      const editing = draftKey === key
      if (!lineNotes && !editing) return null
      return (
        <div className={`line-notes side-${side}`} key={key}>
          {lineNotes?.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              focused={note.id === focusedId}
              editing={note.id === editingId}
              onEditingChange={(editing) => setEditingId(editing ? (note.id ?? null) : null)}
            />
          ))}
          {editing && (
            <NoteEditor
              submitLabel="Add note"
              onCancel={() => setDraft(null)}
              onSubmit={async ({ body, severity }) => {
                const sideLines = lines[side]
                if (!sideLines) return
                const placed = anchorFor ? await anchorFor(side, line) : { anchor: createAnchor(sideLines, line, side) }
                if ('error' in placed) return onRefuse?.(placed.error)
                await addNote(db, { sessionId, path, ...placed, body, severity })
                setDraft(null)
              }}
            />
          )}
        </div>
      )
    },
  }
}
