import { useMemo, useState } from 'react'
import { db } from '../../db/db'
import { addNote, setNoteStatus } from '../../db/notes'
import type { Note, NoteAnchor, NoteSide } from '../../db/schema'
import { acceptSuggestion, dismissSuggestion } from '../../db/suggestions'
import type { LineAnnotations } from '../../diff/DiffTable'
import { lineKey } from '../../diff/hunks'
import type { LineActions, NoteAction } from '../../keys/lineActions'
import { isMultiLine, type LineRange } from '../../keys/selection'
import { createAnchor, isRange, lastLine, linesLabel } from '../../review/anchor'
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
  /** Where a new note on this diff is anchored; the branch-wide diff anchors on the clicked lines themselves. */
  anchorFor?: (side: NoteSide, line: number, endLine: number) => Promise<AnchorResult>
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

const rangeOfAnchor = (anchor: NoteAnchor): LineRange => ({ side: anchor.side, start: anchor.line, end: lastLine(anchor) })

/** A note's card sits under its last line. */
const cardKey = (anchor: NoteAnchor) => lineKey(anchor.side, lastLine(anchor))

function rangeKeys({ side, start, end }: LineRange): string[] {
  const keys: string[] = []
  for (let line = start; line <= end; line++) keys.push(lineKey(side, line))
  return keys
}

function addTo(map: Map<string, Note[]>, key: string, note: Note) {
  map.set(key, [...(map.get(key) ?? []), note])
}

export function useNoteAnnotations({ sessionId, path, notes, lines, focusedId, anchorFor, refuseSide, onRefuse }: Options): LineAnnotations {
  const [draft, setDraft] = useState<{ path: string; range: LineRange } | null>(null)
  const draftRange = draft?.path === path ? draft.range : null
  const draftKey = draftRange ? lineKey(draftRange.side, draftRange.end) : null
  const [editingId, setEditingId] = useState<Note['id'] | null>(null)
  const [hoveredId, setHoveredId] = useState<Note['id'] | null>(null)

  const { byCard, byLine } = useMemo(() => {
    const byCard = new Map<string, Note[]>()
    const byLine = new Map<string, Note[]>()
    for (const note of notes) {
      if (note.anchorLost || note.status === 'dismissed') continue
      addTo(byCard, cardKey(note.anchor), note)
      for (const key of rangeKeys(rangeOfAnchor(note.anchor))) addTo(byLine, key, note)
    }
    return { byCard, byLine }
  }, [notes])

  const pinned = useMemo(
    () => new Set(draftRange ? [...byLine.keys(), ...rangeKeys(draftRange)] : byLine.keys()),
    [byLine, draftRange],
  )

  const shown = (id: string | null | undefined) => (id ? notes.find((note) => note.id === id && !note.anchorLost) : undefined)
  const highlighted = shown(hoveredId) ?? shown(focusedId)
  const highlight =
    highlighted && isRange(highlighted.anchor) ? rangeOfAnchor(highlighted.anchor) : isMultiLine(draftRange) ? draftRange : null

  const actions: LineActions = {
    noted: new Set(byCard.keys()),
    comment: (range) => {
      const refusal = refuseSide?.(range.side)
      if (refusal) return onRefuse?.(refusal)
      setDraft({ path, range })
    },
    act: (action, keys) => {
      for (const key of keys) {
        const note = byLine.get(key)?.find(ACCEPTS[action])
        if (!note || note.id === undefined) continue
        const id = note.id
        const at = cardKey(note.anchor)
        if (action === 'edit') {
          setEditingId(id)
          return { key: at, message: `Editing: ${summary(note)}` }
        }
        if (action === 'resolve') {
          const next = note.status === 'resolved' ? 'open' : 'resolved'
          void setNoteStatus(db, id, next)
          return { key: at, message: `${next === 'resolved' ? 'Resolved' : 'Reopened'}: ${summary(note)}` }
        }
        void (action === 'accept' ? acceptSuggestion(db, id) : dismissSuggestion(db, id))
        return { key: at, message: `${action === 'accept' ? 'Accepted' : 'Dismissed'}: ${summary(note)}` }
      }
      return null
    },
  }

  return {
    pinned,
    actions,
    highlight,
    onComment: actions.comment,
    render: (side, line) => {
      const key = lineKey(side, line)
      const lineNotes = byCard.get(key)
      const editing = draftKey === key ? draftRange : null
      if (!lineNotes && !editing) return null
      return (
        <div className={`line-notes side-${side}`} key={key}>
          {lineNotes?.map((note) => (
            <div key={note.id} onMouseEnter={() => setHoveredId(note.id ?? null)} onMouseLeave={() => setHoveredId(null)}>
              <NoteCard
                note={note}
                focused={note.id === focusedId}
                editing={note.id === editingId}
                onEditingChange={(editing) => setEditingId(editing ? (note.id ?? null) : null)}
              />
            </div>
          ))}
          {editing && (
            <NoteEditor
              submitLabel="save"
              label={isMultiLine(editing) ? linesLabel({ line: editing.start, endLine: editing.end }) : undefined}
              onCancel={() => setDraft(null)}
              onSubmit={async ({ body, severity }) => {
                const sideLines = lines[side]
                if (!sideLines) return
                const { start, end } = editing
                const placed = anchorFor ? await anchorFor(side, start, end) : { anchor: createAnchor(sideLines, start, side, end) }
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
