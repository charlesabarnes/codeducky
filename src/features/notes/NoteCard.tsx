import { Check, Pencil, RotateCcw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { db } from '../../db/db'
import { deleteNote, editNote, setNoteStatus } from '../../db/notes'
import type { Note } from '../../db/schema'
import { SuggestionActions } from './SuggestionActions'
import { Markdown } from './Markdown'
import { NoteEditor } from './NoteEditor'
import { NoteTags } from './NoteBadges'
import { NoteResolution } from './NoteResolution'
import { SeverityLabel } from './Severity'

interface NoteCardProps {
  note: Note
  readOnly?: boolean
  focused?: boolean
  /** Controlled editing, so the e shortcut can open the editor; local state otherwise. */
  editing?: boolean
  onEditingChange?: (editing: boolean) => void
}

const lineLabel = (note: Note) => (note.anchorLost ? null : `line ${note.anchor.line}${note.anchor.side === 'old' ? ' (base)' : ''}`)

export function NoteCard({ note, readOnly, focused, ...controlled }: NoteCardProps) {
  const [localEditing, setLocalEditing] = useState(false)
  const editing = controlled.onEditingChange ? Boolean(controlled.editing) : localEditing
  const setEditing = controlled.onEditingChange ?? setLocalEditing
  const id = note.id!
  const resolved = note.status === 'resolved'
  const pending = note.status === 'suggested' || note.status === 'dismissed'
  const keys = Boolean(controlled.onEditingChange)

  if (editing) {
    return (
      <div className="note-card" id={`note-${id}`}>
        <NoteEditor
          initial={note}
          submitLabel="save"
          onCancel={() => setEditing(false)}
          onSubmit={async (draft) => {
            await editNote(db, id, draft)
            setEditing(false)
          }}
        />
      </div>
    )
  }

  const remove = () => {
    if (window.confirm('Delete this note?')) void deleteNote(db, id)
  }

  return (
    <article className={`note-card${resolved ? ' resolved' : ''}${pending ? ` ${note.status}` : ''}${focused ? ' focused' : ''}`} id={`note-${id}`}>
      <header className="note-head">
        <SeverityLabel severity={note.severity} />
        {lineLabel(note) && <span className="muted">{lineLabel(note)}</span>}
        <NoteTags note={note} />
        <span className="spacer" />
        {!readOnly && (
          <>
            <button type="button" className="link" onClick={() => setEditing(true)}>
              <Pencil size={12} aria-hidden />
              edit{keys && <span className="key">e</span>}
            </button>
            {pending ? (
              <SuggestionActions note={note} keys={keys} />
            ) : (
              <button type="button" className="link" onClick={() => setNoteStatus(db, id, resolved ? 'open' : 'resolved')}>
                {resolved ? <RotateCcw size={12} aria-hidden /> : <Check size={12} aria-hidden />}
                {resolved ? 'reopen' : 'resolve'}
                {keys && <span className="key">r</span>}
              </button>
            )}
            <button type="button" className="link" onClick={remove}>
              <Trash2 size={12} aria-hidden />
              delete
            </button>
          </>
        )}
      </header>
      <div className="note-body">
        <Markdown text={note.body} />
        {note.resolution && <NoteResolution resolution={note.resolution} />}
      </div>
    </article>
  )
}
