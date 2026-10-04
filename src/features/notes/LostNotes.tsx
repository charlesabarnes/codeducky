import type { Note } from '../../db/schema'
import { AnchorExcerpt } from './AnchorExcerpt'
import { NoteCard } from './NoteCard'

interface LostNotesProps {
  notes: Note[]
  heading: string
  focusedId?: string | null
  readOnly?: boolean
}

export function LostNotes({ notes, heading, focusedId, readOnly }: LostNotesProps) {
  if (notes.length === 0) return null
  return (
    <section className="lost-notes stack">
      <h3>{heading}</h3>
      {notes.map((note) => (
        <div key={note.id} className="lost-note">
          <NoteCard note={note} readOnly={readOnly} focused={note.id === focusedId} />
          <AnchorExcerpt note={note} />
        </div>
      ))}
    </section>
  )
}
