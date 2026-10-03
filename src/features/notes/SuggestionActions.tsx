import { db } from '../../db/db'
import type { Note } from '../../db/schema'
import { acceptSuggestion, dismissSuggestion, restoreSuggestion } from '../../db/suggestions'

/** Accept and dismiss controls for suggested notes (added over MCP); renders nothing for other notes. */
export function SuggestionActions({ note }: { note: Note }) {
  const id = note.id
  if (id === undefined) return null
  if (note.status === 'suggested') {
    return (
      <span className="suggestion-actions row">
        <button type="button" className="link" onClick={() => acceptSuggestion(db, id)}>
          Accept
        </button>
        <button type="button" className="link" onClick={() => dismissSuggestion(db, id)}>
          Dismiss
        </button>
      </span>
    )
  }
  if (note.status === 'dismissed') {
    return (
      <span className="suggestion-actions row">
        <button type="button" className="link" onClick={() => restoreSuggestion(db, id)}>
          Restore
        </button>
      </span>
    )
  }
  return null
}
