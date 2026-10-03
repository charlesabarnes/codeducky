import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { db } from '../../db/db'
import type { Repo, Session } from '../../db/schema'
import type { ViewMode } from '../../diff/DiffTable'
import { DiffViewer } from '../../diff/DiffViewer'
import type { FileChange, FileStats } from '../../git/types'
import { PermissionGate } from '../repos/PermissionGate'
import { FileList } from './FileList'
import { useFileContents } from './useFileContents'
import { useSessionScan } from './useSessionScan'

const VIEW_MODE_KEY = 'skelbert.viewMode'

export function SessionPage() {
  const sessionId = Number(useParams().sessionId)
  const data = useLiveQuery(async () => {
    const session = await db.sessions.get(sessionId)
    const repo = session ? await db.repos.get(session.repoId) : undefined
    return { session, repo }
  }, [sessionId])

  if (!data) return <p className="page muted">Loading…</p>
  const { session, repo } = data
  if (!session || !repo) return <p className="page error">Session not found.</p>
  return (
    <PermissionGate handle={repo.dirHandle}>
      <SessionView session={session} repo={repo} />
    </PermissionGate>
  )
}

function SessionView({ session, repo }: { session: Session; repo: Repo }) {
  const scan = useSessionScan(repo.dirHandle, session.baseSha)
  const [params, setParams] = useSearchParams()
  const [mode, setMode] = useState<ViewMode>(() =>
    localStorage.getItem(VIEW_MODE_KEY) === 'split' ? 'split' : 'unified',
  )
  const [generation, setGeneration] = useState(0)

  const selectedPath = params.get('file') ?? scan.files?.[0]?.path ?? null
  const selected = useMemo(
    () => scan.files?.find((file) => file.path === selectedPath) ?? null,
    [scan.files, selectedPath],
  )

  const changeMode = (next: ViewMode) => {
    setMode(next)
    localStorage.setItem(VIEW_MODE_KEY, next)
  }

  const rescan = () => {
    scan.rescan()
    setGeneration((n) => n + 1)
  }

  return (
    <div className="session-layout">
      <aside className="session-sidebar">
        <div className="session-meta stack" style={{ gap: '0.25rem' }}>
          <Link to={`/repos/${repo.id}`}>← {repo.owner ? `${repo.owner}/${repo.name}` : repo.name}</Link>
          <div className="mono">
            {session.branch} vs origin/{repo.baseBranch}
          </div>
          <div className="muted mono">merge base {session.baseSha.slice(0, 7)}</div>
          <div className="row">
            <button type="button" className="secondary" onClick={rescan} disabled={scan.scanning}>
              {scan.scanning ? 'Scanning…' : 'Rescan'}
            </button>
            {scan.files && <Totals files={scan.files} stats={scan.stats} />}
          </div>
        </div>
        {scan.error && <p className="error" style={{ padding: '0 1rem' }}>{scan.error}</p>}
        {scan.files && (
          <FileList
            files={scan.files}
            stats={scan.stats}
            selected={selected?.path ?? null}
            onSelect={(path) => setParams({ file: path }, { replace: true })}
          />
        )}
      </aside>
      <section className="session-content">
        {selected ? (
          <FilePane change={selected} mode={mode} onModeChange={changeMode} generation={generation} />
        ) : (
          !scan.scanning && <p className="diff-notice muted">Select a file.</p>
        )}
      </section>
    </div>
  )
}

function Totals({ files, stats }: { files: FileChange[]; stats: Record<string, FileStats> }) {
  let additions = 0
  let deletions = 0
  for (const value of Object.values(stats)) {
    if ('additions' in value) {
      additions += value.additions
      deletions += value.deletions
    }
  }
  return (
    <span className="counts muted">
      {files.length} {files.length === 1 ? 'file' : 'files'} <span className="add">+{additions}</span>
      <span className="del">−{deletions}</span>
    </span>
  )
}

interface FilePaneProps {
  change: FileChange
  mode: ViewMode
  onModeChange: (mode: ViewMode) => void
  generation: number
}

function FilePane({ change, mode, onModeChange, generation }: FilePaneProps) {
  const { contents, error, loading, loadLarge } = useFileContents(change, generation)
  return (
    <>
      <div className="diff-toolbar">
        <span className="path mono">{change.path}</span>
        <div className="segmented" role="group" aria-label="Diff layout">
          {(['unified', 'split'] as const).map((option) => (
            <button key={option} type="button" aria-pressed={mode === option} onClick={() => onModeChange(option)}>
              {option === 'unified' ? 'Unified' : 'Split'}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="diff-notice error">{error}</p>}
      {loading && <p className="diff-notice muted">Loading…</p>}
      {contents && <DiffViewer contents={contents} mode={mode} onLoadLarge={loadLarge} />}
    </>
  )
}
