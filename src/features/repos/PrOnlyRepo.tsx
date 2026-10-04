import { useLiveQuery } from 'dexie-react-hooks'
import { FolderOpen, GitPullRequest, History } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Crumbs, StatusBar } from '../../app/chrome'
import { repoHistoryPath } from '../../app/paths'
import { GithubIcon } from '../../ui/GithubIcon'
import { PageHeader } from '../../ui/PageHeader'
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
      <Crumbs>
        <strong>{repoLabel(repo)}</strong>
      </Crumbs>
      <StatusBar mode="repo">
        <span className="strong">{repoLabel(repo)}</span>
        <span>pull requests only</span>
      </StatusBar>
      <PageHeader icon={GithubIcon} title={repoLabel(repo)} back={{ to: '/', label: 'repos' }}>
        <p className="muted">Reviewed from GitHub pull requests. There is no local checkout of it on this device.</p>
        <Link to={repoHistoryPath(repo.id)} className="icon-link">
          <History size={13} aria-hidden />
          session history
        </Link>
      </PageHeader>
      <div className="sub-section">
        <h3>pull request sessions</h3>
        {sessions?.length === 0 ? (
          <p>None yet.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>pull request</th>
                <th>state</th>
                <th>started</th>
              </tr>
            </thead>
            <tbody>
              {sessions?.map((session) => (
                <tr key={session.id}>
                  <td>
                    <span className="cell-icon">
                      <GitPullRequest size={12} aria-hidden />
                      <Link className="repo-link" to={`/sessions/${session.id}`}>
                        #{session.pr?.number} {session.pr?.title ?? session.branch}
                      </Link>
                    </span>
                  </td>
                  <td className="muted">
                    {session.status === 'active'
                      ? 'in review'
                      : `submitted${session.review ? `: ${session.review.state.toLowerCase().replace('_', ' ')}` : ''}`}
                  </td>
                  <td className="muted">{new Date(session.startedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {supportsFileSystemAccess() && (
        <div className="stack">
          <div>
            <button type="button" className="secondary" onClick={locate}>
              <FolderOpen size={13} aria-hidden />
              open a local checkout
            </button>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
      )}
      <RepoInstructions repo={repo} />
    </section>
  )
}
