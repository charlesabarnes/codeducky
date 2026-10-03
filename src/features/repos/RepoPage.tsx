import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { db } from '../../db/db'
import type { Repo } from '../../db/schema'
import { activeSession, startNewSession, startOrResumeSession } from '../../db/sessions'
import { gitService } from '../../git/client'
import type { RepoInfo } from '../../git/types'
import { PermissionGate } from './PermissionGate'

export function RepoPage() {
  const repoId = Number(useParams().repoId)
  const repo = useLiveQuery(() => db.repos.get(repoId), [repoId])

  if (repo === undefined) return <p className="page muted">Loading…</p>
  return (
    <PermissionGate handle={repo.dirHandle}>
      <RepoDetails repo={repo} />
    </PermissionGate>
  )
}

function RepoDetails({ repo }: { repo: Repo }) {
  const navigate = useNavigate()
  const repoId = repo.id!
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
      const sessionId = fresh ? await startNewSession(db, params) : await startOrResumeSession(db, params)
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
        <Link to={`/repos/${repoId}/history`}>Session history</Link>
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
    </section>
  )
}
