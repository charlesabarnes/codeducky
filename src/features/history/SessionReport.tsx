import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Link } from 'react-router'
import { db } from '../../db/db'
import { repoLabel } from '../../db/repos'
import type { Note, Repo, Session } from '../../db/schema'
import { compareNotes, countNotes } from '../../review/summary'
import { SessionChecklists } from '../checklists/SessionChecklists'
import { AnchorExcerpt } from '../notes/AnchorExcerpt'
import { NoteCard } from '../notes/NoteCard'
import { exportSessionReport } from './exportReport'
import { repoHistoryPath } from '../../app/paths'

function groupByFile(notes: Note[]): [string, Note[]][] {
  const groups = new Map<string, Note[]>()
  for (const note of [...notes].sort(compareNotes)) groups.set(note.path, [...(groups.get(note.path) ?? []), note])
  return [...groups]
}

export function SessionReport({ session, repo }: { session: Session; repo: Repo }) {
  const sessionId = session.id!
  const notes = useLiveQuery(() => db.notes.where({ sessionId }).toArray(), [sessionId])
  const [error, setError] = useState<string | null>(null)
  if (!notes) return <p className="page muted">Loading…</p>
  const counts = countNotes(notes)

  const exportReport = () => exportSessionReport(session, repo).catch((err: unknown) => setError(String(err)))

  return (
    <section className="page stack report-page">
      <div>
        <Link to={repoHistoryPath(repo.id!)}>← History</Link>
        <h1>
          {repoLabel(repo)} · {session.branch}
        </h1>
        <p className="muted">
          Read-only {session.status === 'archived' ? 'archived ' : ''}session started {new Date(session.startedAt).toLocaleString()}.
          Head <span className="mono">{session.headSha.slice(0, 7)}</span>, merge base{' '}
          <span className="mono">{session.baseSha.slice(0, 7)}</span>.
        </p>
        <p className="muted">
          {counts.total} notes: {counts.byStatus.open} open, {counts.byStatus.resolved} resolved,{' '}
          {counts.possiblyResolved} possibly resolved.
        </p>
        <div className="row">
          <button type="button" className="secondary" onClick={exportReport}>
            Export markdown
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
      <h2>Checklists</h2>
      <SessionChecklists sessionId={sessionId} repoId={session.repoId} readOnly />
      <h2>Notes</h2>
      {notes.length === 0 && <p className="muted">No notes.</p>}
      {groupByFile(notes).map(([path, fileNotes]) => (
        <section key={path} className="stack" style={{ gap: '0.5rem' }}>
          <h3 className="mono">{path}</h3>
          {fileNotes.map((note) => (
            <div key={note.id} className="stack" style={{ gap: '0.25rem' }}>
              <NoteCard note={note} readOnly />
              <AnchorExcerpt note={note} />
            </div>
          ))}
        </section>
      ))}
    </section>
  )
}
