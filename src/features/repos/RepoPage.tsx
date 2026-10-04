import { useLiveQuery } from 'dexie-react-hooks'
import { Folder, GitBranch, GitCommitHorizontal, History, Play, Plus } from 'lucide-react'
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
import { Crumbs, StatusBar } from '../../app/chrome'
import { repoHistoryPath } from '../../app/paths'
import { GithubIcon } from '../../ui/GithubIcon'
import { PageHeader } from '../../ui/PageHeader'
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

  const title = info.owner ? `${info.owner}/${info.name}` : repo.name
  const head = info.headSha.slice(0, 7)

  return (
    <section className="page narrow stack">
      <Crumbs>
        <strong>{title}</strong>
      </Crumbs>
      <StatusBar mode="repo">
        <span className="strong">{title}</span>
        <span>
          {branch ?? 'detached HEAD'} @ {head}
        </span>
      </StatusBar>
      <PageHeader icon={info.owner ? GithubIcon : Folder} title={title} back={{ to: '/', label: 'repos' }}>
        <dl className="meta-grid">
          <dt>
            <Folder size={12} aria-hidden />
            folder
          </dt>
          <dd>{repo.folderName}</dd>
          <dt>
            <GitBranch size={12} aria-hidden />
            branch
          </dt>
          <dd>{branch ?? 'detached HEAD'}</dd>
          <dt>
            <GitCommitHorizontal size={12} aria-hidden />
            head
          </dt>
          <dd>{head}</dd>
        </dl>
        {!info.owner && <p className="muted">No GitHub remote named origin was found.</p>}
        <Link to={repoHistoryPath(repoId)} className="icon-link">
          <History size={13} aria-hidden />
          session history
        </Link>
      </PageHeader>

      {info.baseBranches.length === 0 ? (
        <p className="error">No origin/* branches found locally. Fetch from the terminal, then reopen.</p>
      ) : (
        <label className="field base-field">
          <span>base branch</span>
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

      <div className="stack session-start">
        <div className="row">
          <button type="button" disabled={busy || !branch || !baseBranch} onClick={() => start(false)}>
            <Play size={13} aria-hidden />
            {existing ? 'resume session' : 'start session'}
          </button>
          {existing && (
            <button type="button" className="secondary" disabled={busy} onClick={() => start(true)}>
              <Plus size={13} aria-hidden />
              start new session
            </button>
          )}
        </div>
        {existing && (
          <p className="muted">
            Session started {new Date(existing.startedAt).toLocaleString()}. Starting a new session archives it and carries its
            open notes over.
          </p>
        )}
      </div>
      <RepoInstructions repo={repo} />
    </section>
  )
}
