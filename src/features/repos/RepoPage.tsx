import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { db } from '../../db/db'
import type { OpenedRepo } from '../../db/schema'
import { activeSession, startNewSession, startOrResumeSession } from '../../db/sessions'
import { gitService } from '../../git/client'
import type { RepoInfo } from '../../git/types'
import { resolveGitHubBase } from '../github/baseActions'
import { githubDefaultBase } from '../github/defaultBase'
import { RepoFolderGate } from './RepoFolderGate'
import { RepoInstructions } from './RepoInstructions'
import { repoHistoryPath } from '../../app/paths'
import { PrOnlyRepo } from './PrOnlyRepo'

export function RepoPage() {
  const repoId = useParams().repoId ?? ''
  const repo = useLiveQuery(async () => (await db.repos.get(repoId)) ?? null, [repoId])

  if (repo === undefined) return <p className="page muted">Loading…</p>
  if (repo === null) return <p className="page error">Repo not found.</p>
  if (!repo.folderName) return <PrOnlyRepo repo={{ ...repo, id: repoId }} />
  return <RepoFolderGate repo={{ ...repo, id: repoId }}>{(opened) => <RepoDetails repo={opened} />}</RepoFolderGate>
}

function RepoDetails({ repo }: { repo: OpenedRepo }) {
  const navigate = useNavigate()
  const repoId = repo.id
  const [info, setInfo] = useState<RepoInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    gitService()
      .open(repo.dirHandle)
      .then((result) => !cancelled && setInfo(result))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      cancelled = true
    }
  }, [repo.dirHandle])

  const savedBaseMissing = info !== null && !info.baseBranches.includes(repo.baseBranch)
  useEffect(() => {
    if (!info || !savedBaseMissing) return
    githubDefaultBase(info, info.baseBranches).then((base) => {
      if (base) db.repos.update(repoId, { baseBranch: base })
    })
  }, [info, savedBaseMissing, repoId])

  const branch = info?.branch ?? null
  const existing = useLiveQuery(
    () => (branch ? activeSession(db, repoId, branch) : undefined),
    [repoId, branch],
  )

  if (error) return <p className="page error">{error}</p>
  if (!info) return <p className="page muted">Reading repository…</p>

  const baseBranch = info.baseBranches.includes(repo.baseBranch) ? repo.baseBranch : (info.defaultBase ?? '')

  const start = async (fresh: boolean) => {
    if (!branch || !baseBranch) return
    setBusy(true)
    setError(null)
    try {
      await db.repos.update(repoId, { baseBranch })
      const base = await gitService().resolveBase(baseBranch)
      const current = await gitService().info()
      const params = { repoId, branch, headSha: current.headSha, baseSha: base.mergeBaseSha }
      const sessionId = fresh
        ? await startNewSession(db, params)
        : await startOrResumeSession(db, params, () => resolveGitHubBase(repo, baseBranch))
      navigate(`/sessions/${sessionId}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <section className="page narrow stack">
      <div>
        <Link to="/">← Repos</Link>
        <h1>{info.owner ? `${info.owner}/${info.name}` : repo.name}</h1>
        <p className="muted mono">
          {repo.folderName} · {branch ?? 'detached HEAD'} @ {info.headSha.slice(0, 7)}
        </p>
        {!info.owner && <p className="muted">No GitHub remote named origin was found.</p>}
        <Link to={repoHistoryPath(repoId)}>Session history</Link>
      </div>

      {info.baseBranches.length === 0 ? (
        <p className="error">No origin/* branches found locally. Fetch from the terminal, then reopen.</p>
      ) : (
        <label className="field">
          <span>Base branch</span>
          <select value={baseBranch} onChange={(e) => db.repos.update(repoId, { baseBranch: e.target.value })}>
            {info.baseBranches.map((name) => (
              <option key={name} value={name}>
                origin/{name}
              </option>
            ))}
          </select>
        </label>
      )}

      {!branch && <p className="error">HEAD is detached. Check out a branch to start a review session.</p>}

      <div className="row">
        <button type="button" disabled={busy || !branch || !baseBranch} onClick={() => start(false)}>
          {existing ? 'Resume session' : 'Start session'}
        </button>
        {existing && (
          <button type="button" className="secondary" disabled={busy} onClick={() => start(true)}>
            Start new session
          </button>
        )}
      </div>
      {existing && (
        <p className="muted">
          Session started {new Date(existing.startedAt).toLocaleString()}. Starting a new session archives it and carries
          its open notes over.
        </p>
      )}
      <RepoInstructions repo={repo} />
    </section>
  )
}
