import { Check, Undo2, X } from 'lucide-react'
import { db } from '../../db/db'
import type { Note } from '../../db/schema'
import { acceptSuggestion, dismissSuggestion, restoreSuggestion } from '../../db/suggestions'

/** Accept and dismiss controls for suggested notes (added over MCP); renders nothing for other notes. */
export function SuggestionActions({ note, keys }: { note: Note; keys?: boolean }) {
  const id = note.id
  if (id === undefined) return null
  if (note.status === 'suggested') {
    return (
      <span className="suggestion-actions row">
        <button type="button" className="link" onClick={() => acceptSuggestion(db, id)}>
          <Check size={12} aria-hidden />
          accept{keys && <span className="key">a</span>}
        </button>
        <button type="button" className="link" onClick={() => dismissSuggestion(db, id)}>
          <X size={12} aria-hidden />
          dismiss{keys && <span className="key">d</span>}
        </button>
      </span>
    )
  }
  if (note.status === 'dismissed') {
    return (
      <span className="suggestion-actions row">
        <button type="button" className="link" onClick={() => restoreSuggestion(db, id)}>
          <Undo2 size={12} aria-hidden />
          restore
        </button>
      </span>
    )
  }
  return null
}
