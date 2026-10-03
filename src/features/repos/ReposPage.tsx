import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { db } from '../../db/db'
import { supportsFileSystemAccess } from '../../fs/permission'
import { openRepoFolder } from './openRepoFolder'

export function ReposPage() {
  const navigate = useNavigate()
  const repos = useLiveQuery(() => db.repos.orderBy('lastOpenedAt').reverse().toArray(), [])
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)

  const onOpen = async () => {
    setError(null)
    setOpening(true)
    try {
      const repoId = await openRepoFolder()
      if (repoId !== null) navigate(`/repos/${repoId}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setOpening(false)
    }
  }

  return (
    <section className="page narrow stack">
      <div>
        <h1>Repos</h1>
        <p className="muted">Open a local checkout to review its working tree against a base branch. Access is read-only.</p>
      </div>
      {supportsFileSystemAccess() ? (
        <div>
          <button type="button" onClick={onOpen} disabled={opening}>
            {opening ? 'Opening…' : 'Open repo folder'}
          </button>
        </div>
      ) : (
        <p className="error">This browser does not support the File System Access API. Use a Chromium-based desktop browser.</p>
      )}
      {error && <p className="error">{error}</p>}
      {repos && repos.length > 0 && (
        <ul className="repo-list">
          {repos.map((repo) => (
            <li key={repo.id} className="card">
              <Link to={`/repos/${repo.id}`}>
                <strong>{repo.owner ? `${repo.owner}/${repo.name}` : repo.name}</strong>
              </Link>
              <div className="muted">
                {repo.folderName}
                {repo.baseBranch && ` · base origin/${repo.baseBranch}`}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
