import { useState } from 'react'
import { NOTE_SEVERITIES, type Note, type NoteSeverity } from '../../db/schema'
import { lineSpan } from '../../review/anchor'
import { compareNotes, matchesStatus, type StatusFilter } from '../../review/summary'
import { SuggestionActions } from './SuggestionActions'
import { NoteBadges } from './NoteBadges'

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'active', label: 'open and suggested' },
  { value: 'open', label: 'open' },
  { value: 'suggested', label: 'suggestions' },
  { value: 'resolved', label: 'resolved' },
  { value: 'possibly-resolved', label: 'possibly resolved' },
  { value: 'dismissed', label: 'dismissed' },
  { value: 'all', label: 'all statuses' },
]

interface NotesPanelProps {
  notes: Note[]
  selectedId: string | null
  onSelect: (note: Note) => void
}

export function NotesPanel({ notes, selectedId, onSelect }: NotesPanelProps) {
  const [status, setStatus] = useState<StatusFilter>('active')
  const [severity, setSeverity] = useState<NoteSeverity | 'all'>('all')
  const shown = notes
    .filter((note) => matchesStatus(note, status) && (severity === 'all' || note.severity === severity))
    .sort(compareNotes)

  return (
    <div className="notes-panel">
      <div className="row filters">
        <select value={status} aria-label="Status" onChange={(event) => setStatus(event.target.value as StatusFilter)}>
          {STATUS_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          value={severity}
          aria-label="Severity"
          onChange={(event) => setSeverity(event.target.value as NoteSeverity | 'all')}
        >
          <option value="all">all severities</option>
          {NOTE_SEVERITIES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
      {shown.length === 0 ? (
        <p className="muted panel-message">
          {notes.length === 0 ? 'No notes yet. Click a line in the diff to add one.' : 'No notes match.'}
        </p>
      ) : (
        <ul className="note-list">
          {shown.map((note) => (
            <li key={note.id} className={note.status === 'suggested' ? 'suggested' : undefined}>
              <button type="button" aria-current={note.id === selectedId} onClick={() => onSelect(note)}>
                <span className="note-tags">
                  <NoteBadges note={note} />
                </span>
                <span className="note-where mono">
                  {note.path}
                  {note.anchorLost ? '' : `:${lineSpan(note.anchor)}${note.anchor.side === 'old' ? ' (base)' : ''}${note.commit ? ` @${note.commit.slice(0, 7)}` : ''}`}
                </span>
                <span className="note-snippet">{note.title ?? note.body.split('\n')[0]}</span>
              </button>
              <SuggestionActions note={note} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
