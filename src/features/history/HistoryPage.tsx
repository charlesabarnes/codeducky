import { useLiveQuery } from 'dexie-react-hooks'
import { Link, useParams } from 'react-router'
import { db } from '../../db/db'
import { repoHistory } from '../../db/history'
import { repoLabel } from '../../db/repos'

export function HistoryPage() {
  const repoId = Number(useParams().repoId)
  const data = useLiveQuery(async () => {
    const repo = await db.repos.get(repoId)
    return { repo, history: repo ? await repoHistory(db, repoId) : [] }
  }, [repoId])

  if (!data) return <p className="page muted">Loading…</p>
  const { repo, history } = data
  if (!repo) return <p className="page error">Repo not found.</p>

  return (
    <section className="page stack">
      <div>
        <Link to={`/repos/${repoId}`}>← {repoLabel(repo)}</Link>
        <h1>History</h1>
      </div>
      {history.length === 0 ? (
        <p className="muted">No sessions yet.</p>
      ) : (
        <table className="history-table">
          <thead>
            <tr>
              <th>Branch</th>
              <th>Started</th>
              <th>Head</th>
              <th>Open</th>
              <th>Resolved</th>
              <th>Possibly resolved</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {history.map(({ session, counts }) => (
              <tr key={session.id}>
                <td className="mono">{session.branch}</td>
                <td>{new Date(session.startedAt).toLocaleString()}</td>
                <td className="mono">{session.headSha.slice(0, 7)}</td>
                <td>{counts.byStatus.open}</td>
                <td>{counts.byStatus.resolved}</td>
                <td>{counts.possiblyResolved}</td>
                <td>
                  <Link to={`/sessions/${session.id}`}>{session.status === 'active' ? 'Resume' : 'View'}</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
