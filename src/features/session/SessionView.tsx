import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { db } from '../../db/db'
import { setViewed } from '../../db/fileViews'
import { repoLabel } from '../../db/repos'
import type { Note, Repo, Session } from '../../db/schema'
import type { ViewMode } from '../../diff/DiffTable'
import type { FileChange, FileStats } from '../../git/types'
import { contentHash, viewedPaths } from '../../review/viewed'
import { SessionChecklists } from '../checklists/SessionChecklists'
import { useChecklistProgress } from '../checklists/useChecklistProgress'
import { BaseBanner } from '../github/BaseBanner'
import { PushDialog } from '../github/PushDialog'
import { useBaseFreshness } from '../github/useBaseFreshness'
import { repoRef } from '../../github/connect'
import { exportSessionReport } from '../history/exportReport'
import { NotesPanel } from '../notes/NotesPanel'
import { FileList, type FileNoteCount } from './FileList'
import { FilePane, OrphanPane, type NoteFocus } from './FilePane'
import { useReanchor } from './useReanchor'
import { useSessionScan } from './useSessionScan'

const VIEW_MODE_KEY = 'skelbert.viewMode'
const EMPTY_NOTES: Note[] = []

type Tab = 'files' | 'notes' | 'checklists'

function countByFile(notes: Note[]): Map<string, FileNoteCount> {
  const counts = new Map<string, FileNoteCount>()
  for (const note of notes) {
    if (note.status !== 'open') continue
    const count = counts.get(note.path) ?? { open: 0, lost: 0 }
    count.open++
    if (note.anchorLost) count.lost++
    counts.set(note.path, count)
  }
  return counts
}

export function SessionView({ session, repo }: { session: Session; repo: Repo }) {
  const sessionId = session.id!
  const scan = useSessionScan(repo.dirHandle, session.baseSha, session.baseSource === 'github' ? repoRef(repo) : null)
  useReanchor(sessionId, scan.files)
  const [params, setParams] = useSearchParams()
  const [mode, setMode] = useState<ViewMode>(() =>
    localStorage.getItem(VIEW_MODE_KEY) === 'split' ? 'split' : 'unified',
  )
  const [generation, setGeneration] = useState(0)
  const [tab, setTab] = useState<Tab>('files')
  const [focus, setFocus] = useState<NoteFocus | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [pushOpen, setPushOpen] = useState(false)
  const freshness = useBaseFreshness(repo, scan.files !== null, generation)

  const notes = useLiveQuery(() => db.notes.where({ sessionId }).toArray(), [sessionId]) ?? EMPTY_NOTES
  const views = useLiveQuery(() => db.fileViews.where({ sessionId }).toArray(), [sessionId])
  const checklists = useChecklistProgress(sessionId, repo.id!)

  const viewed = useMemo(() => viewedPaths(scan.files ?? [], views ?? []), [scan.files, views])
  const noteCounts = useMemo(() => countByFile(notes), [notes])
  const selectedPath = params.get('file') ?? scan.files?.[0]?.path ?? null
  const selected = useMemo(
    () => scan.files?.find((file) => file.path === selectedPath) ?? null,
    [scan.files, selectedPath],
  )
  const fileNotes = useMemo(() => notes.filter((note) => note.path === selectedPath), [notes, selectedPath])

  const changeMode = (next: ViewMode) => {
    setMode(next)
    localStorage.setItem(VIEW_MODE_KEY, next)
  }
  const rescan = () => {
    scan.rescan()
    setGeneration((n) => n + 1)
  }
  const selectFile = (path: string) => setParams({ file: path }, { replace: true })
  const toggleViewed = (file: FileChange) =>
    setViewed(db, { sessionId, path: file.path, contentHash: contentHash(file), viewed: !viewed.has(file.path) })
  const jumpTo = (note: Note) => {
    selectFile(note.path)
    setFocus({ id: note.id!, at: Date.now() })
  }
  const exportReport = async () => {
    setExportError(null)
    try {
      await exportSessionReport(session, repo, scan.files ?? undefined)
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error))
    }
  }

  const openNotes = notes.filter((note) => note.status === 'open').length
  const items = checklists?.lists.flatMap((list) => list.items) ?? []
  const ticked = items.filter((item) => checklists?.checked.has(item.id)).length

  return (
    <div className="session-layout">
      <aside className="session-sidebar">
        <div className="session-meta stack" style={{ gap: '0.25rem' }}>
          <Link to={`/repos/${repo.id}`}>← {repoLabel(repo)}</Link>
          <div className="mono">
            {session.branch} vs origin/{repo.baseBranch}
          </div>
          <div className="muted mono">
            merge base {session.baseSha.slice(0, 7)}
            {session.baseSource === 'github' && ' (from GitHub)'}
          </div>
          <div className="row">
            <button type="button" className="secondary" onClick={rescan} disabled={scan.scanning}>
              {scan.scanning ? 'Scanning…' : 'Rescan'}
            </button>
            <button type="button" className="secondary" onClick={exportReport} disabled={!scan.files}>
              Export
            </button>
            <button type="button" className="secondary" onClick={() => setPushOpen(true)} disabled={!repo.owner}>
              Push
            </button>
            {scan.files && <Totals files={scan.files} stats={scan.stats} />}
          </div>
          {scan.files && scan.files.length > 0 && <ViewedProgress viewed={viewed.size} total={scan.files.length} />}
          {exportError && <p className="error">{exportError}</p>}
        </div>
        <div className="tabs" role="tablist">
          <TabButton tab="files" current={tab} onSelect={setTab} label={`Files ${scan.files?.length ?? ''}`} />
          <TabButton tab="notes" current={tab} onSelect={setTab} label={`Notes ${openNotes || ''}`} />
          <TabButton
            tab="checklists"
            current={tab}
            onSelect={setTab}
            label={items.length ? `Checklists ${ticked}/${items.length}` : 'Checklists'}
          />
        </div>
        {scan.error && <p className="error" style={{ padding: '0 1rem' }}>{scan.error}</p>}
        {tab === 'files' && scan.files && (
          <FileList
            files={scan.files}
            stats={scan.stats}
            selected={selected?.path ?? null}
            noteCounts={noteCounts}
            viewed={viewed}
            onSelect={selectFile}
            onToggleViewed={toggleViewed}
          />
        )}
        {tab === 'notes' && <NotesPanel notes={notes} selectedId={focus?.id ?? null} onSelect={jumpTo} />}
        {tab === 'checklists' && <SessionChecklists sessionId={sessionId} repoId={repo.id!} />}
      </aside>
      <section className="session-content">
        <BaseBanner state={freshness} session={session} repo={repo} />
        {selected ? (
          <FilePane
            key={selected.path}
            sessionId={sessionId}
            change={selected}
            notes={fileNotes}
            mode={mode}
            onModeChange={changeMode}
            generation={generation}
            viewed={viewed.has(selected.path)}
            onToggleViewed={() => toggleViewed(selected)}
            focus={focus}
          />
        ) : selectedPath && fileNotes.length > 0 && scan.files ? (
          <OrphanPane path={selectedPath} notes={fileNotes} focus={focus} />
        ) : (
          !scan.scanning && <p className="diff-notice muted">Select a file.</p>
        )}
      </section>
      {pushOpen && <PushDialog session={session} repo={repo} notes={notes} onClose={() => setPushOpen(false)} />}
    </div>
  )
}

function TabButton({ tab, current, onSelect, label }: { tab: Tab; current: Tab; onSelect: (tab: Tab) => void; label: string }) {
  return (
    <button type="button" role="tab" aria-selected={tab === current} onClick={() => onSelect(tab)}>
      {label}
    </button>
  )
}

function ViewedProgress({ viewed, total }: { viewed: number; total: number }) {
  return (
    <div className="viewed-progress">
      <progress max={total} value={viewed} />
      <span className="muted">
        {viewed}/{total} viewed
      </span>
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
