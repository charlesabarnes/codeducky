import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowRight, GitBranch, GitPullRequest, History } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { db } from '../../db/db'
import { repoHistory } from '../../db/history'
import { repoLabel } from '../../db/repos'
import { Crumbs, StatusBar } from '../../app/chrome'
import { repoPath } from '../../app/paths'
import { PageHeader } from '../../ui/PageHeader'

export function HistoryPage() {
  const repoId = useParams().repoId ?? ''
  const data = useLiveQuery(async () => {
    const repo = await db.repos.get(repoId)
    return { repo, history: repo ? await repoHistory(db, repoId) : [] }
  }, [repoId])

  if (!data) return <p className="page muted">Loading…</p>
  const { repo, history } = data
  if (!repo) return <p className="page error">Repo not found.</p>

  const active = history.find(({ session }) => session.status === 'active')

  return (
    <section className="page stack history-page">
      <Crumbs>
        <Link to={repoPath(repoId)}>{repoLabel(repo)}</Link>
        <span>/</span>
        <strong>history</strong>
      </Crumbs>
      <StatusBar mode="history">
        <span className="strong">
          {history.length} {history.length === 1 ? 'session' : 'sessions'}
        </span>
      </StatusBar>
      <PageHeader icon={History} title="history" back={{ to: repoPath(repoId), label: repoLabel(repo) }} />
      {history.length === 0 ? (
        <p className="muted">No sessions yet.</p>
      ) : (
        <table className="data-table history-table">
          <thead>
            <tr>
              <th className="caret" />
              <th>branch</th>
              <th>started</th>
              <th>head</th>
              <th className="num">open</th>
              <th className="num">resolved</th>
              <th className="num">possibly resolved</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {history.map(({ session, counts }) => {
              const current = session === active?.session
              const isPr = session.source === 'github-pr' && session.pr
              return (
                <tr key={session.id} className={current ? 'current' : undefined}>
                  <td className="caret">{current ? '›' : ''}</td>
                  <td>
                    <span className="cell-icon">
                      {isPr ? <GitPullRequest size={12} aria-hidden /> : <GitBranch size={12} aria-hidden />}
                      {isPr ? `#${session.pr!.number} ${session.branch}` : session.branch}
                      {session.review && <span className="badge">{session.review.state.toLowerCase().replace('_', ' ')}</span>}
                    </span>
                  </td>
                  <td className="muted">{new Date(session.startedAt).toLocaleString()}</td>
                  <td className="muted">{session.headSha.slice(0, 7)}</td>
                  <td className={`num ${counts.byStatus.open ? 'warn-text' : 'muted'}`}>{counts.byStatus.open}</td>
                  <td className="num ok-text">{counts.byStatus.resolved}</td>
                  <td className={`num ${counts.possiblyResolved ? 'warn-text' : 'muted'}`}>{counts.possiblyResolved}</td>
                  <td className="num">
                    <Link to={`/sessions/${session.id}`} className="icon-link">
                      {session.status === 'active' ? 'resume' : 'view'}
                      <ArrowRight size={12} aria-hidden />
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}
