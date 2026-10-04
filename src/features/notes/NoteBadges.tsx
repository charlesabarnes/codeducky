import type { Note } from '../../db/schema'
import { SeverityLabel } from './Severity'

export function NoteBadges({ note }: { note: Note }) {
  return (
    <>
      <SeverityLabel severity={note.severity} />
      <NoteTags note={note} />
    </>
  )
}

/** Status and provenance, next to the severity. */
export function NoteTags({ note }: { note: Note }) {
  return (
    <>
      {note.status !== 'open' && <span className="badge">{note.status}</span>}
      {note.anchorLost && note.status === 'open' && (
        <span className="badge lost" title="The anchored line is no longer in the file">
          possibly resolved
        </span>
      )}
      {note.carriedFrom !== undefined && (
        <span className="badge" title="Carried over from the previous session">
          carried over
        </span>
      )}
      {note.github?.reviewId !== undefined && (
        <span className="badge" title="Sent to GitHub in a review">
          on github
        </span>
      )}
      {note.commit && (
        <span className="badge" title={`On commit ${note.commit}: the line is gone from the final version of the file`}>
          @{note.commit.slice(0, 7)}
        </span>
      )}
      {note.source === 'claude' && <span className="badge">claude</span>}
      {note.source === 'mcp' && <span className="badge">mcp</span>}
    </>
  )
}
