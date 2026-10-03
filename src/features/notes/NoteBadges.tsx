import type { Note } from '../../db/schema'

export function NoteBadges({ note }: { note: Note }) {
  return (
    <>
      <span className={`badge severity-${note.severity}`}>{note.severity}</span>
      {note.status !== 'open' && <span className="badge">{note.status}</span>}
      {note.anchorLost && note.status === 'open' && (
        <span className="badge lost" title="The anchored line is no longer in the file">
          possibly resolved
        </span>
      )}
      {note.carriedFrom !== undefined && (
        <span className="badge muted" title="Carried over from the previous session">
          carried over
        </span>
      )}
      {note.source === 'claude' && <span className="badge">Claude</span>}
    </>
  )
}
