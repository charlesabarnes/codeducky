import { useLiveQuery } from 'dexie-react-hooks'
import { Folder, FolderGit2, FolderOpen } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { db } from '../../db/db'
import { supportsFileSystemAccess } from '../../fs/permission'
import { openRepoFolder } from './openRepoFolder'
import { StatusBar } from '../../app/chrome'
import { repoPath } from '../../app/paths'
import { repoLabel } from '../../db/repos'
import { GithubIcon } from '../../ui/GithubIcon'
import { FolderAccessNotice } from '../pwa/FolderAccess'
import { PageHeader } from '../../ui/PageHeader'

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
      if (repoId !== null) navigate(repoPath(repoId))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setOpening(false)
    }
  }

  return (
    <section className="page narrow stack">
      <StatusBar mode="repos">
        <span className="strong">
          {repos?.length ?? 0} {repos?.length === 1 ? 'repo' : 'repos'}
        </span>
      </StatusBar>
      <PageHeader icon={FolderGit2} title="repos">
        <p>Open a local checkout to review its working tree against a base branch. Access is read-only.</p>
      </PageHeader>
      {supportsFileSystemAccess() ? (
        <div>
          <button type="button" onClick={onOpen} disabled={opening}>
            <FolderOpen size={13} aria-hidden />
            {opening ? 'opening…' : 'open repo folder'}
          </button>
        </div>
      ) : (
        <p className="error">This browser does not support the File System Access API. Use a Chromium-based desktop browser.</p>
      )}
      {error && <p className="error">{error}</p>}
      {supportsFileSystemAccess() && <FolderAccessNotice />}
      {repos && repos.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th className="caret" />
              <th>repo</th>
              <th className="col-fixed">folder</th>
              <th className="col-fixed">base</th>
            </tr>
          </thead>
          <tbody>
            {repos.map((repo) => {
              const Icon = repo.owner ? GithubIcon : Folder
              return (
                <tr key={repo.id}>
                  <td className="caret" />
                  <td>
                    <span className="cell-icon">
                      <Icon size={13} aria-hidden />
                      <Link className="repo-link" to={repoPath(repo.id!)}>
                        {repoLabel(repo)}
                      </Link>
                    </span>
                  </td>
                  <td className="muted">{repo.folderName || '—'}</td>
                  <td className={repo.baseBranch ? undefined : 'muted'}>{repo.baseBranch ? `origin/${repo.baseBranch}` : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}
