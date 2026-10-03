import { useState } from 'react'
import { db } from '../../db/db'
import { deleteNote, editNote, setNoteStatus } from '../../db/notes'
import type { Note } from '../../db/schema'
import { SuggestionActions } from '../claude/SuggestionActions'
import { Markdown } from './Markdown'
import { NoteEditor } from './NoteEditor'
import { NoteBadges } from './NoteBadges'

interface NoteCardProps {
  note: Note
  readOnly?: boolean
  focused?: boolean
  /** Controlled editing, so the e shortcut can open the editor; local state otherwise. */
  editing?: boolean
  onEditingChange?: (editing: boolean) => void
}

export function NoteCard({ note, readOnly, focused, ...controlled }: NoteCardProps) {
  const [localEditing, setLocalEditing] = useState(false)
  const editing = controlled.onEditingChange ? Boolean(controlled.editing) : localEditing
  const setEditing = controlled.onEditingChange ?? setLocalEditing
  const id = note.id!
  const resolved = note.status === 'resolved'
  const pending = note.status === 'suggested' || note.status === 'dismissed'

  if (editing) {
    return (
      <div className="note-card" id={`note-${id}`}>
        <NoteEditor
          initial={note}
          submitLabel="Save"
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
    <article
      className={`note-card severity-${note.severity}${resolved ? ' resolved' : ''}${pending ? ` ${note.status}` : ''}${focused ? ' focused' : ''}`}
      id={`note-${id}`}
    >
      <header className="row">
        <NoteBadges note={note} />
        <span className="spacer" />
        {!readOnly && (
          <>
            <button type="button" className="link" onClick={() => setEditing(true)}>
              Edit
            </button>
            {pending ? (
              <SuggestionActions note={note} />
            ) : (
              <button type="button" className="link" onClick={() => setNoteStatus(db, id, resolved ? 'open' : 'resolved')}>
                {resolved ? 'Reopen' : 'Resolve'}
              </button>
            )}
            <button type="button" className="link danger" onClick={remove}>
              Delete
            </button>
          </>
        )}
      </header>
      <Markdown text={note.body} />
    </article>
  )
}
