import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { db } from '../../db/db'
import { setViewed } from '../../db/fileViews'
import { repoLabel } from '../../db/repos'
import type { Note, OpenedRepo, Session } from '../../db/schema'
import type { ViewMode } from '../../diff/DiffTable'
import type { MoveTarget } from '../../diff/moved'
import type { FileChange, FileStats } from '../../git/types'
import { orderFiles, riskOf, type Risk } from '../../review/order'
import { contentHash, viewedPaths } from '../../review/viewed'
import { SessionChecklists } from '../checklists/SessionChecklists'
import { useChecklistProgress } from '../checklists/useChecklistProgress'
import { BaseBanner } from '../github/BaseBanner'
import { PushDialog } from '../github/PushDialog'
import { useBaseFreshness } from '../github/useBaseFreshness'
import { CiChip } from '../ci/CiChip'
import { useCiStatus } from '../ci/useCiStatus'
import { repoRef } from '../../github/connect'
import { exportSessionReport } from '../history/exportReport'
import { useKeys, useShortcuts } from '../../keys/context'
import type { NavRequest } from '../../keys/diffNavContext'
import { withShortcut } from '../../keys/help'
import { NotesPanel } from '../notes/NotesPanel'
import { FileList, type FileNoteCount } from './FileList'
import { filterFiles, nextUnviewed, stepFile } from './fileNav'
import { FilePane, OrphanPane, type NoteFocus } from './FilePane'
import { currentPath, renamedPaths } from './renames'
import { useReanchor } from './useReanchor'
import { useFileSummary } from './useFileSummary'
import { useSessionScan } from './useSessionScan'
import { useViewPrefs } from './useViewPrefs'
import { repoPath } from '../../app/paths'

const EMPTY_NOTES: Note[] = []

type Tab = 'files' | 'notes' | 'checklists'
const TAB_SHORTCUTS = { files: 'tab.files', notes: 'tab.notes', checklists: 'tab.checklists' } as const

function countByFile(notes: Note[], renamed: ReadonlyMap<string, string>): Map<string, FileNoteCount> {
  const counts = new Map<string, FileNoteCount>()
  for (const note of notes) {
    if (note.status !== 'open') continue
    const path = currentPath(note.path, renamed)
    const count = counts.get(path) ?? { open: 0, lost: 0 }
    count.open++
    if (note.anchorLost) count.lost++
    counts.set(path, count)
  }
  return counts
}

export function SessionView({ session, repo }: { session: Session; repo: OpenedRepo }) {
  const sessionId = session.id!
  const scan = useSessionScan(repo.dirHandle, session.baseSha, session.baseSource === 'github' ? repoRef(repo) : null)
  useReanchor(sessionId, scan.files)
  useFileSummary(sessionId, scan.files, scan.stats, scan.scanning)
  const [params, setParams] = useSearchParams()
  const prefs = useViewPrefs()
  const { mode, ignoreWhitespace, order } = prefs
  const [generation, setGeneration] = useState(0)
  const [tab, setTab] = useState<Tab>('files')
  const [focus, setFocus] = useState<NoteFocus | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [pushOpen, setPushOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [navRequest, setNavRequest] = useState<NavRequest | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const { announce } = useKeys()
  const freshness = useBaseFreshness(repo, scan.files !== null, generation)

  const notes = useLiveQuery(() => db.notes.where({ sessionId }).toArray(), [sessionId]) ?? EMPTY_NOTES
  const views = useLiveQuery(() => db.fileViews.where({ sessionId }).toArray(), [sessionId])
  const checklists = useChecklistProgress(sessionId, repo.id!)

  const ci = useCiStatus(repo, scan.files, generation)

  const viewed = useMemo(() => viewedPaths(scan.files ?? [], views ?? []), [scan.files, views])
  const renamed = useMemo(() => renamedPaths(scan.files), [scan.files])
  const noteCounts = useMemo(() => countByFile(notes, renamed), [notes, renamed])
  const risks = useMemo(() => {
    if (order !== 'risk' || !scan.files) return null
    return new Map<string, Risk>(
      scan.files.map((file) => [file.path, riskOf(file, { stats: scan.stats[file.path], openNotes: noteCounts.get(file.path)?.open })]),
    )
  }, [order, scan.files, scan.stats, noteCounts])
  const orderedFiles = useMemo(
    () =>
      orderFiles(scan.files ?? [], order, (file) => ({ stats: scan.stats[file.path], openNotes: noteCounts.get(file.path)?.open })),
    [scan.files, scan.stats, order, noteCounts],
  )
  const requestedPath = params.get('file')
  const selectedPath = requestedPath === null ? (orderedFiles[0]?.path ?? null) : currentPath(requestedPath, renamed)
  const selected = useMemo(
    () => scan.files?.find((file) => file.path === selectedPath) ?? null,
    [scan.files, selectedPath],
  )
  const fileNotes = useMemo(
    () => notes.filter((note) => currentPath(note.path, renamed) === selectedPath),
    [notes, selectedPath, renamed],
  )
  const shownFiles = useMemo(() => filterFiles(orderedFiles, filter), [orderedFiles, filter])
  const shownPaths = shownFiles.map((file) => file.path)

  const changeMode = (next: ViewMode) => prefs.setMode(next)
  const rescan = () => {
    scan.rescan()
    setGeneration((n) => n + 1)
  }
  const selectFile = (path: string) => setParams({ file: path }, { replace: true })
  const goToFile = (path: string, target?: NavRequest['target'], scroll?: NavRequest['scroll']) => {
    selectFile(path)
    setNavRequest(target ? { at: Date.now(), target, scroll } : null)
    announce(`File ${path}`)
  }
  const openMoved = useCallback(
    (target: MoveTarget) => {
      setParams({ file: target.path }, { replace: true })
      setNavRequest({ at: Date.now(), target: { side: target.side, line: target.line }, scroll: 'center' })
      announce(`Moved block in ${target.path}, line ${target.line}`)
    },
    [setParams, announce],
  )
  const toggleWhitespace = (ignore: boolean) => {
    prefs.setIgnoreWhitespace(ignore)
    announce(ignore ? 'Whitespace changes hidden' : 'Whitespace changes shown', { visible: true })
  }
  const onBoundary = (direction: 1 | -1) => {
    const target = stepFile(shownPaths, selectedPath, direction, (path) => viewed.has(path))
    if (!target) return false
    goToFile(target, direction > 0 ? 'first-change' : 'last-change')
    return true
  }
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

  const stepFiles = (delta: 1 | -1) => {
    const target = stepFile(shownPaths, selectedPath, delta)
    if (target) goToFile(target)
    else announce(delta > 0 ? 'This is the last file' : 'This is the first file', { visible: true })
  }
  const switchTab = (next: Tab) => {
    setTab(next)
    announce(`${next[0]!.toUpperCase()}${next.slice(1)} tab`)
  }
  useShortcuts('session', {
    'file.next': () => stepFiles(1),
    'file.prev': () => stepFiles(-1),
    'file.viewed': () => {
      if (!selected) return false
      const nowViewed = !viewed.has(selected.path)
      void toggleViewed(selected)
      if (!nowViewed) return announce('Marked as not viewed', { visible: true })
      const next = nextUnviewed(shownPaths, selected.path, viewed)
      if (!next) return announce(filter.trim() ? 'Viewed. Every matching file is viewed' : 'Viewed. Every file is viewed', { visible: true })
      goToFile(next, 'first-change')
      announce(`Viewed. Next: ${next}`, { visible: true })
    },
    'view.mode': () => {
      const next = mode === 'split' ? 'unified' : 'split'
      changeMode(next)
      announce(next === 'split' ? 'Split view' : 'Unified view', { visible: true })
    },
    'view.whitespace': () => toggleWhitespace(!ignoreWhitespace),
    'files.filter': () => {
      setTab('files')
      requestAnimationFrame(() => filterRef.current?.select())
    },
    'tab.files': () => switchTab('files'),
    'tab.notes': () => switchTab('notes'),
    'tab.checklists': () => switchTab('checklists'),
  })

  const openNotes = notes.filter((note) => note.status === 'open').length
  const suggested = notes.filter((note) => note.status === 'suggested').length
  const items = checklists?.lists.flatMap((list) => list.items) ?? []
  const ticked = items.filter((item) => checklists?.checked.has(item.id)).length

  return (
    <div className="session-layout">
      <aside className="session-sidebar">
        <div className="session-meta stack" style={{ gap: '0.25rem' }}>
          <Link to={repoPath(repo.id!)}>← {repoLabel(repo)}</Link>
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
          <CiChip view={ci} />
          {scan.renamesLimited && (
            <p className="muted" title="Too many added and deleted files to compare their contents">
              Only identical renames were detected.
            </p>
          )}
          {exportError && <p className="error">{exportError}</p>}
        </div>
        <div className="tabs" role="tablist">
          <TabButton tab="files" current={tab} onSelect={setTab} label={`Files ${scan.files?.length ?? ''}`} />
          <TabButton tab="notes" current={tab} onSelect={setTab} label={`Notes ${openNotes || ''}${suggested ? ` +${suggested}` : ''}`} />
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
            files={shownFiles}
            total={scan.files.length}
            filter={filter}
            onFilterChange={setFilter}
            filterRef={filterRef}
            stats={scan.stats}
            selected={selected?.path ?? null}
            noteCounts={noteCounts}
            viewed={viewed}
            onSelect={(path) => goToFile(path)}
            onToggleViewed={toggleViewed}
            order={order}
            onOrderChange={prefs.setOrder}
            risks={risks}
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
            ignoreWhitespace={ignoreWhitespace}
            onIgnoreWhitespaceChange={toggleWhitespace}
            moved={scan.moved[selected.path]}
            onOpenMoved={openMoved}
            ci={ci}
            generation={generation}
            viewed={viewed.has(selected.path)}
            onToggleViewed={() => toggleViewed(selected)}
            focus={focus}
            navRequest={navRequest}
            onBoundary={onBoundary}
          />
        ) : selectedPath && fileNotes.length > 0 && scan.files ? (
          <OrphanPane path={selectedPath} notes={fileNotes} focus={focus} />
        ) : (
          !scan.scanning && <p className="diff-notice muted">Select a file.</p>
        )}
      </section>
      {pushOpen && <PushDialog session={session} repo={repo} notes={notes} files={scan.files} onClose={() => setPushOpen(false)} />}
    </div>
  )
}

function TabButton({ tab, current, onSelect, label }: { tab: Tab; current: Tab; onSelect: (tab: Tab) => void; label: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={tab === current}
      onClick={() => onSelect(tab)}
      title={withShortcut(`${tab[0]!.toUpperCase()}${tab.slice(1)} tab`, TAB_SHORTCUTS[tab])}
    >
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
