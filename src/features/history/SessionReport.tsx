import { useLiveQuery } from 'dexie-react-hooks'
import { Download, FileText, ListChecks, MessageSquare } from 'lucide-react'
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
import { Crumbs, StatusBar } from '../../app/chrome'
import { repoHistoryPath } from '../../app/paths'
import { PageHeader } from '../../ui/PageHeader'
import { Panel } from '../../ui/Panel'
import { prPath } from '../../../shared/links'

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
      <Crumbs>
        <Link to={repoHistoryPath(repo.id!)}>{repoLabel(repo)}</Link>
        <span>/</span>
        <strong>{session.branch}</strong>
      </Crumbs>
      <StatusBar mode="report">
        <span className="strong">{session.branch}</span>
        <span>read-only</span>
        <span className="status-item">
          <MessageSquare size={12} aria-hidden />
          {counts.total} {counts.total === 1 ? 'note' : 'notes'}
        </span>
      </StatusBar>
      <PageHeader icon={FileText} title={`${repoLabel(repo)} · ${session.branch}`} back={{ to: repoHistoryPath(repo.id!), label: 'history' }}>
        <p className="muted">
          Read-only {session.status === 'archived' ? 'archived ' : ''}session started {new Date(session.startedAt).toLocaleString()}.
          Head <code>{session.headSha.slice(0, 7)}</code>, merge base <code>{session.baseSha.slice(0, 7)}</code>.
        </p>
        {session.pr && session.source === 'github-pr' && (
          <p>
            Pull request{' '}
            <a href={session.pr.url ?? `https://github.com/${session.pr.owner}/${session.pr.name}/pull/${session.pr.number}`} target="_blank" rel="noreferrer">
              #{session.pr.number} {session.pr.title}
            </a>
            {session.review && (
              <>
                {' '}
                · review submitted: <strong>{session.review.state.toLowerCase().replace('_', ' ')}</strong>{' '}
                {new Date(session.review.at).toLocaleString()}
                {session.review.url && (
                  <>
                    {' '}
                    (<a href={session.review.url} target="_blank" rel="noreferrer">on GitHub</a>)
                  </>
                )}
              </>
            )}
            {' · '}
            <Link to={prPath(session.pr)}>Review again</Link>
          </p>
        )}
        <p className="muted">
          {counts.total} notes: {counts.byStatus.open} open, {counts.byStatus.resolved} resolved,{' '}
          {counts.possiblyResolved} possibly resolved.
        </p>
      </PageHeader>
      <div className="row">
        <button type="button" className="secondary" onClick={exportReport}>
          <Download size={13} aria-hidden />
          export markdown
        </button>
        {error && <span className="error">{error}</span>}
      </div>
      <Panel icon={ListChecks} title="checklists">
        <SessionChecklists sessionId={sessionId} repoId={session.repoId} readOnly />
      </Panel>
      <Panel icon={MessageSquare} title="notes">
        {notes.length === 0 && <p>No notes.</p>}
        {groupByFile(notes).map(([path, fileNotes]) => (
          <section key={path} className="report-file">
            <h3>{path}</h3>
            {fileNotes.map((note) => (
              <div key={note.id} className="lost-note">
                <NoteCard note={note} readOnly />
                <AnchorExcerpt note={note} />
              </div>
            ))}
          </section>
        ))}
      </Panel>
    </section>
  )
}
