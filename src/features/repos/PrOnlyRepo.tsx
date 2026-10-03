import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Link } from 'react-router'
import { repoHistoryPath } from '../../app/paths'
import { db } from '../../db/db'
import { repoLabel } from '../../db/repos'
import { isPrSession, type Repo } from '../../db/schema'
import { supportsFileSystemAccess } from '../../fs/permission'
import { locateRepoFolder } from './openRepoFolder'
import { RepoInstructions } from './RepoInstructions'

/** A repo known only from pull request reviews: its PR sessions, and a way to attach a local checkout. */
export function PrOnlyRepo({ repo }: { repo: Repo & { id: string } }) {
  const sessions = useLiveQuery(
    async () => (await db.sessions.where({ repoId: repo.id }).filter(isPrSession).toArray()).sort((a, b) => b.startedAt - a.startedAt),
    [repo.id],
  )
  const [error, setError] = useState<string | null>(null)
  const locate = () => locateRepoFolder(repo).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  return (
    <section className="page narrow stack">
      <div>
        <Link to="/">← Repos</Link>
        <h1>{repoLabel(repo)}</h1>
        <p className="muted">Reviewed from GitHub pull requests. There is no local checkout of it on this device.</p>
        <Link to={repoHistoryPath(repo.id)}>Session history</Link>
      </div>
      <h2>Pull request sessions</h2>
      {sessions?.length === 0 && <p className="muted">None yet.</p>}
      <ul className="repo-list">
        {sessions?.map((session) => (
          <li key={session.id} className="card">
            <Link to={`/sessions/${session.id}`}>
              #{session.pr?.number} {session.pr?.title ?? session.branch}
            </Link>
            <div className="muted">
              {session.status === 'active' ? 'In review' : `Submitted${session.review ? `: ${session.review.state.toLowerCase().replace('_', ' ')}` : ''}`} ·
              started {new Date(session.startedAt).toLocaleString()}
            </div>
          </li>
        ))}
      </ul>
      {supportsFileSystemAccess() && (
        <div className="stack" style={{ gap: '0.35rem' }}>
          <div>
            <button type="button" className="secondary" onClick={locate}>
              Open a local checkout
            </button>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
      )}
      <RepoInstructions repo={repo} />
    </section>
  )
}
