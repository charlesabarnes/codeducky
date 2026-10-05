import { useLiveQuery } from 'dexie-react-hooks'
import {
  ArrowLeft,
  CircleCheck,
  Download,
  ExternalLink,
  Eye,
  FileDiff,
  Files,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  GitPullRequestArrow,
  ListChecks,
  MessageSquare,
  MessagesSquare,
  RefreshCw,
  Send,
  type LucideIcon,
} from 'lucide-react'
import { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { db } from '../../db/db'
import { repoLabel } from '../../db/repos'
import { isPatchSession, type Note, type Repo, type Session } from '../../db/schema'
import type { ViewMode } from '../../diff/DiffTable'
import type { MoveTarget } from '../../diff/moved'
import type { FileChange, FileStats } from '../../git/types'
import { orderFiles, riskOf, type Risk } from '../../review/order'
import { viewedPaths } from '../../review/viewed'
import { SessionChecklists } from '../checklists/SessionChecklists'
import { useChecklistProgress } from '../checklists/useChecklistProgress'
import { BaseBanner } from '../github/BaseBanner'
import { PushDialog } from '../github/PushDialog'
import { localPushTarget } from '../github/pushTargets'
import { useBranchPull } from '../github/useBranchPull'
import { prPath } from '../../../shared/links'
import type { GitHubClient } from '../../github/client'
import type { PrSnapshot } from '../../github/prDiff'
import { orderThreads, type ReviewThread } from '../../github/threads'
import { ConversationPanel } from '../pr/ConversationPanel'
import { PrHeader } from '../pr/PrHeader'
import { prPushTarget } from '../pr/prPushTarget'
import { SubmitReviewDialog } from '../pr/SubmitReviewDialog'
import type { ThreadActions } from '../pr/ThreadCard'
import type { ConversationState } from '../pr/usePrConversation'
import type { PrThreadsApi } from '../pr/usePrThreads'
import type { DiffSource } from './source'
import { useBaseFreshness } from '../github/useBaseFreshness'
import { CiChip } from '../ci/CiChip'
import { ClaudeActions } from '../claude/ClaudeActions'
import { useCiStatus } from '../ci/useCiStatus'
import { exportSessionReport } from '../history/exportReport'
import { useKeys, useShortcuts } from '../../keys/context'
import type { NavRequest } from '../../keys/diffNavContext'
import { withShortcut } from '../../keys/help'
import { isMac } from '../../keys/tokens'
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
import { Crumbs, StatusBar, type StatusHint } from '../../app/chrome'
import { ModeBar } from '../modes/ModeBar'
import { recordViewed } from '../modes/recordViewed'
import { SinceBanner } from '../modes/SinceBanner'
import { useReviewMode, type ReviewMode } from '../modes/useReviewMode'
import { describeRange } from '../../review/commitRange'
import type { EditSource } from '../editor/editSource'
import { useLeaveGuard } from '../editor/useLeaveGuard'
import { openFileWindow, shareNoteFocus, useDirtyElsewhere, usePublishDirty } from '../window/windowSync'

const EditorPane = lazy(async () => ({ default: (await import('../editor/EditorPane')).EditorPane }))

const EMPTY_NOTES: Note[] = []
const SESSION_HINTS: StatusHint[] = [
  { keys: 'j/k', label: 'line' },
  { keys: 'n/p', label: 'change' },
  { keys: ']/[', label: 'file' },
  { keys: 'c', label: 'comment' },
]
const EDIT_HINTS: StatusHint[] = [
  { keys: isMac() ? '⌘S' : 'Ctrl+S', label: 'save' },
  { keys: isMac() ? '⌘F' : 'Ctrl+F', label: 'find' },
  { keys: 'esc tab', label: 'leave editor' },
]
const NO_THREADS: ReviewThread[] = []

type Tab = 'files' | 'notes' | 'checklists' | 'conversation'
const TAB_SHORTCUTS = { files: 'tab.files', notes: 'tab.notes', checklists: 'tab.checklists', conversation: 'tab.conversation' } as const

/** What a pull request session adds: the PR, its threads and conversation, and a way to reload them. */
export interface PrView {
  gh: GitHubClient
  snapshot: PrSnapshot
  threads: PrThreadsApi
  conversation: ConversationState
  refresh: () => void
  refreshing: boolean
}

interface SessionViewProps {
  session: Session
  repo: Repo
  source: DiffSource
  /** This device's checkout, for local sessions. */
  dirHandle: FileSystemDirectoryHandle | null
  pr: PrView | null
}

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

export function SessionView({ session, repo, source, dirHandle, pr }: SessionViewProps) {
  const sessionId = session.id!
  const scan = useSessionScan(source)
  useReanchor(sessionId, scan.files, source)
  useFileSummary(sessionId, scan.files, scan.stats, scan.scanning)
  const [params, setParams] = useSearchParams()
  const prefs = useViewPrefs()
  const { mode, ignoreWhitespace, order } = prefs
  const [generation, setGeneration] = useState(0)
  const [tab, setTab] = useState<Tab>('files')
  const [focus, setFocus] = useState<NoteFocus | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [pushOpen, setPushOpen] = useState(false)
  const [submitOpen, setSubmitOpen] = useState(false)
  const [threadFocus, setThreadFocus] = useState<{ id: string; at: number } | null>(null)
  const [replyingId, setReplyingId] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [navRequest, setNavRequest] = useState<NavRequest | null>(null)
  const [dirtyPath, setDirtyPath] = useState<string | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const { announce } = useKeys()
  const isLocal = dirHandle !== null
  const isPatch = isPatchSession(session)
  const modes = useReviewMode({ session, source, scan, dirHandle, pr: pr && { gh: pr.gh, snapshot: pr.snapshot }, generation })
  const display = modes.display
  const branchWide = modes.mode.kind === 'all'
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const freshness = useBaseFreshness(repo, isLocal && scan.files !== null, generation)
  const branchPull = useBranchPull(session, repo, isLocal && scan.files !== null)

  const notes = useLiveQuery(() => db.notes.where({ sessionId }).toArray(), [sessionId]) ?? EMPTY_NOTES
  const views = useLiveQuery(() => db.fileViews.where({ sessionId }).toArray(), [sessionId])
  const checklists = useChecklistProgress(sessionId, repo.id!)

  const ci = useCiStatus(repo, source, scan.files, generation)

  const viewed = useMemo(() => viewedPaths(scan.files ?? [], views ?? []), [scan.files, views])
  const renamed = useMemo(() => renamedPaths(scan.files), [scan.files])
  const noteCounts = useMemo(() => countByFile(notes, renamed), [notes, renamed])
  const risks = useMemo(() => {
    if (order !== 'risk' || !display.files) return null
    return new Map<string, Risk>(
      display.files.map((file) => [file.path, riskOf(file, { stats: display.stats[file.path], openNotes: noteCounts.get(file.path)?.open })]),
    )
  }, [order, display.files, display.stats, noteCounts])
  const orderedFiles = useMemo(
    () =>
      orderFiles(display.files ?? [], order, (file) => ({ stats: display.stats[file.path], openNotes: noteCounts.get(file.path)?.open })),
    [display.files, display.stats, order, noteCounts],
  )
  const requestedPath = params.get('file')
  const requested = requestedPath === null ? null : currentPath(requestedPath, renamed)
  // Outside All changes a file that is not in the view falls back to the first one listed.
  const selectedPath =
    requested === null || (!branchWide && display.files && !display.files.some((file) => file.path === requested))
      ? (orderedFiles[0]?.path ?? null)
      : requested
  const selected = useMemo(
    () => display.files?.find((file) => file.path === selectedPath) ?? null,
    [display.files, selectedPath],
  )
  const editing = params.get('view') === 'edit'
  const prGh = pr?.gh
  const prSnapshot = pr?.snapshot
  const editSource = useMemo<EditSource | null>(
    () => (dirHandle ? { kind: 'local', root: dirHandle } : prGh && prSnapshot ? { kind: 'github', gh: prGh, snapshot: prSnapshot } : null),
    [dirHandle, prGh, prSnapshot],
  )
  const editBlockedFor = (change: FileChange | null) =>
    !editSource
      ? isPatch
        ? 'A patch is read-only'
        : 'Editing needs the local checkout or a pull request'
      : !change
        ? 'Only files changed on the branch can be edited'
        : change.status === 'deleted'
          ? 'This file was deleted on the branch'
          : null
  const editBlocked = editBlockedFor(selected ? modes.branchChange(selected.path) : null)
  // The editor follows the file in the URL, not the one the review mode shows, so a mode switch never swaps out
  // unsaved edits; a dirty editor stays mounted (hidden) until it is saved or a guarded navigation discards it.
  const editPath = requested ?? selectedPath
  const editTarget = editPath ? modes.branchChange(editPath) : null
  const editorChange = dirtyPath
    ? modes.branchChange(dirtyPath)
    : editing && editBlockedFor(editTarget) === null
      ? editTarget
      : null
  const showEditor = editing && editorChange !== null && editorChange.path === editPath
  useLeaveGuard(dirtyPath)
  usePublishDirty(sessionId, dirtyPath)
  const dirtyElsewhere = useDirtyElsewhere(sessionId)
  const fileNotes = useMemo(
    () => notes.filter((note) => currentPath(note.path, renamed) === selectedPath),
    [notes, selectedPath, renamed],
  )
  const shownFiles = useMemo(() => filterFiles(orderedFiles, filter), [orderedFiles, filter])
  const shownPaths = shownFiles.map((file) => file.path)

  const allThreads = pr?.threads.data?.threads ?? NO_THREADS
  const threadOrder = useMemo(() => orderThreads(allThreads, orderedFiles.map((file) => file.path)), [allThreads, orderedFiles])
  const fileThreads = useMemo(
    () => (pr && selectedPath ? allThreads.filter((thread) => thread.path === selectedPath) : null),
    [pr, allThreads, selectedPath],
  )
  const focusedThread = threadFocus ? (allThreads.find((thread) => thread.id === threadFocus.id) ?? null) : null
  const focusThread = (thread: ReviewThread) => setThreadFocus({ id: thread.id, at: Date.now() })
  const threadActions = useMemo<ThreadActions | null>(
    () =>
      pr
        ? {
            focusedId: threadFocus?.id ?? null,
            focusAt: threadFocus?.at ?? 0,
            replyingId,
            onReplyingChange: setReplyingId,
            onFocus: (thread) => setThreadFocus((current) => (current?.id === thread.id ? current : { id: thread.id, at: Date.now() })),
            reply: pr.threads.reply,
            setResolved: pr.threads.setResolved,
          }
        : null,
    [pr, threadFocus, replyingId],
  )

  const changeMode = (next: ViewMode) => prefs.setMode(next)
  const rescan = () => {
    if (pr) {
      pr.refresh()
      return
    }
    scan.rescan()
    setGeneration((n) => n + 1)
  }
  /** Moving within the files keeps the editor open; jumping to a note, thread or change shows the diff. */
  const selectFile = (path: string, keepView = false) =>
    setParams(keepView && editing ? { file: path, view: 'edit' } : { file: path }, { replace: true })
  const goToFile = (path: string, target?: NavRequest['target'], scroll?: NavRequest['scroll']) => {
    selectFile(path, !target)
    setNavRequest(target ? { at: Date.now(), target, scroll } : null)
    announce(`File ${path}`)
  }
  /** Opening edits the file the diff shows; closing keeps the edited file selected. */
  const setEditing = (next: boolean) => {
    const path = next ? selectedPath : editPath
    if (!path) return
    setParams(next ? { file: path, view: 'edit' } : { file: path }, { replace: true })
    announce(next ? `Editing ${path}` : 'Diff', { visible: true })
  }
  const toggleEditor = () => {
    if (!showEditor && editBlocked) return announce(editBlocked, { visible: true })
    setEditing(!showEditor)
  }
  const onSaved = (message: string) => {
    announce(message, { visible: true })
    rescan()
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
  /** Viewed is per file for the whole branch, so every view toggles the branch's change for the path. */
  const toggleViewed = (file: FileChange) => {
    const change = modes.branchChange(file.path)
    if (!change) return
    recordViewed(sessionId, change, !viewed.has(change.path), pr ? pr.snapshot.pull.headSha : isPatch ? session.headSha : null).catch((error: unknown) =>
      console.error('Could not record the review', error),
    )
  }
  const switchMode = (next: ReviewMode, message?: string) => {
    modes.setMode(next)
    setNavRequest(null)
    if (message) announce(message, { visible: true })
  }
  const toggleSince = () =>
    isPatch
      ? announce('A patch has no earlier looks to compare with', { visible: true })
      : modes.mode.kind === 'since'
      ? switchMode({ kind: 'all' }, 'All changes')
      : switchMode({ kind: 'since' }, 'Since last look: only what changed since you viewed each file')
  const stepCommits = (delta: 1 | -1) => {
    if (isPatch) return announce('A patch has no commits to step through', { visible: true })
    if (modes.commits.status !== 'ready') return announce(modes.commits.status === 'loading' ? 'Commits are still loading' : 'Could not list the commits', { visible: true })
    if (modes.commits.commits.length === 0) return announce('No commits on this branch yet', { visible: true })
    const next = modes.stepCommits(delta)
    setNavRequest(null)
    if (next.kind !== 'commits') return announce('All changes', { visible: true })
    const index = modes.commits.commits.findIndex((commit) => commit.sha === next.toSha)
    announce(`Commit ${index + 1} of ${modes.commits.commits.length}: ${describeRange(modes.commits.commits, { from: index, to: index })}`, { visible: true })
  }
  const jumpTo = (note: Note) => {
    selectFile(note.path)
    setFocus({ id: note.id!, at: Date.now() })
    shareNoteFocus(sessionId, currentPath(note.path, renamed), note.id!)
  }
  const openWindow = (path: string) => {
    if (!openFileWindow(sessionId, path)) announce('The browser blocked the new window', { visible: true })
  }
  const exportReport = async () => {
    setExportError(null)
    try {
      await exportSessionReport(session, repo, scan.files ?? undefined)
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error))
    }
  }

  const goToThread = (thread: ReviewThread, index: number) => {
    setTab('files')
    selectFile(thread.path)
    setNavRequest(thread.line !== null && !thread.fileLevel ? { at: Date.now(), target: { side: thread.side, line: thread.line }, scroll: 'none' } : null)
    focusThread(thread)
    const where = thread.line !== null && !thread.fileLevel ? `line ${thread.line}` : thread.isOutdated ? 'outdated' : 'file comment'
    announce(`Thread ${index + 1} of ${threadOrder.length}: ${thread.path}, ${where}${thread.isResolved ? ', resolved' : ''}`, { visible: true })
  }
  const stepThreads = (delta: 1 | -1) => {
    if (threadOrder.length === 0) return announce('No review threads on this pull request', { visible: true })
    const current = focusedThread ? threadOrder.findIndex((thread) => thread.id === focusedThread.id) : -1
    const next = current < 0 ? (delta > 0 ? 0 : threadOrder.length - 1) : current + delta
    const thread = threadOrder[next]
    if (!thread) return announce(delta > 0 ? 'No more threads' : 'No earlier threads', { visible: true })
    goToThread(thread, next)
  }
  const replyToFocused = () => {
    if (!focusedThread) return announce('Jump to a thread with t first', { visible: true })
    if (!focusedThread.canReply) return announce('You cannot reply to this thread', { visible: true })
    setTab('files')
    selectFile(focusedThread.path)
    setReplyingId(focusedThread.id)
    focusThread(focusedThread)
  }
  const resolveFocused = () => {
    if (!focusedThread || !pr) return announce('Jump to a thread with t first', { visible: true })
    const next = !focusedThread.isResolved
    if (next ? !focusedThread.canResolve : !focusedThread.canUnresolve) {
      return announce(`You cannot ${next ? 'resolve' : 'unresolve'} this thread`, { visible: true })
    }
    pr.threads
      .setResolved(focusedThread, next)
      .then(() => announce(next ? 'Thread resolved' : 'Thread unresolved', { visible: true }))
      .catch((error: unknown) => announce(`Could not update the thread: ${error instanceof Error ? error.message : String(error)}`, { visible: true }))
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
    'file.edit': toggleEditor,
    'file.window': () => (selected ? openWindow(selected.path) : false),
    'mode.since': toggleSince,
    'mode.all': () => switchMode({ kind: 'all' }, 'All changes'),
    'commit.next': () => stepCommits(1),
    'commit.prev': () => stepCommits(-1),
  })
  useShortcuts(
    'session',
    {
      'thread.next': () => stepThreads(1),
      'thread.prev': () => stepThreads(-1),
      'thread.reply': replyToFocused,
      'thread.resolve': resolveFocused,
      'tab.conversation': () => switchTab('conversation'),
    },
    pr !== null,
  )

  const openNotes = notes.filter((note) => note.status === 'open').length
  const suggested = notes.filter((note) => note.status === 'suggested').length
  const items = checklists?.lists.flatMap((list) => list.items) ?? []
  const ticked = items.filter((item) => checklists?.checked.has(item.id)).length

  const fileOpenNotes = fileNotes.filter((note) => note.status === 'open').length
  const shortSha = (sha: string) => sha.slice(0, 7)

  return (
    <div className="session-layout">
      <Crumbs>
        {isPatch ? <Link to="/">patch</Link> : <Link to={repoPath(repo.id!)}>{repoLabel(repo)}</Link>}
        <span>/</span>
        {isPatch ? (
          <strong>{session.branch}</strong>
        ) : pr ? (
          <>
            <strong>#{pr.snapshot.pull.number}</strong>
            <span>{pr.snapshot.pull.headRef}</span>
            <span>→</span>
            <span>{pr.snapshot.pull.baseRef}</span>
          </>
        ) : (
          <>
            <strong>{session.branch}</strong>
            <span>←</span>
            <span>origin/{repo.baseBranch}</span>
          </>
        )}
      </Crumbs>
      <StatusBar mode={showEditor ? 'edit' : pr ? 'pr review' : isPatch ? 'patch review' : 'review'} hints={showEditor ? EDIT_HINTS : SESSION_HINTS}>
        {selected && <span className="strong">{selected.path.slice(selected.path.lastIndexOf('/') + 1)}</span>}
        {dirtyPath && <span>unsaved</span>}
        {modes.mode.kind !== 'all' && <span>{modes.mode.kind === 'since' ? 'since last look' : 'commits'}</span>}
        {selected && (
          <span className="status-item">
            <MessageSquare size={12} aria-hidden />
            {fileOpenNotes} {fileOpenNotes === 1 ? 'note' : 'notes'}
          </span>
        )}
      </StatusBar>
      <aside className="session-sidebar">
        <div className="session-meta">
          {pr && (
            <Link to="/inbox" className="back-link">
              <ArrowLeft size={13} aria-hidden />
              inbox
            </Link>
          )}
          <dl className="meta-grid">
            {isPatch ? (
              <>
                <MetaLabel icon={FileDiff} label="patch" />
                <dd>{session.branch}</dd>
              </>
            ) : pr ? (
              <>
                <MetaLabel icon={GitPullRequest} label="pr" />
                <dd>
                  <a href={pr.snapshot.pull.htmlUrl} target="_blank" rel="noreferrer">
                    {repoLabel(repo)}#{pr.snapshot.pull.number}
                  </a>
                </dd>
                <MetaLabel icon={GitBranch} label="branch" />
                <dd>
                  {pr.snapshot.pull.headRef} <span className="muted">→ {pr.snapshot.pull.baseRef}</span>
                </dd>
                <MetaLabel icon={GitCommitHorizontal} label="head" />
                <dd>{shortSha(session.headSha)}</dd>
              </>
            ) : (
              <>
                <MetaLabel icon={GitBranch} label="branch" />
                <dd>{session.branch}</dd>
                <MetaLabel icon={GitCommitHorizontal} label="base" />
                <dd>
                  origin/{repo.baseBranch}{' '}
                  <span className="muted">
                    @ {shortSha(session.baseSha)}
                    {session.baseSource === 'github' && ' (github)'}
                  </span>
                </dd>
                {branchPull && repo.owner && (
                  <>
                    <MetaLabel icon={GitPullRequest} label="pr" />
                    <dd className="row branch-pull">
                      <Link to={prPath({ owner: repo.owner, name: repo.name, number: branchPull.number })} title="Open PR in Code Ducky">
                        #{branchPull.number}
                      </Link>
                      <a href={branchPull.htmlUrl} target="_blank" rel="noreferrer" className="icon-link muted">
                        github
                        <ExternalLink size={11} aria-hidden />
                      </a>
                    </dd>
                  </>
                )}
              </>
            )}
            {scan.files && (
              <>
                <MetaLabel icon={FileDiff} label="diff" />
                <dd>
                  <Totals files={scan.files} stats={scan.stats} />
                </dd>
              </>
            )}
            {ci.status.kind !== 'off' && (
              <>
                <MetaLabel icon={CircleCheck} label="ci" />
                <dd>
                  <CiChip view={ci} />
                </dd>
              </>
            )}
            {scan.files && scan.files.length > 0 && (
              <>
                <MetaLabel icon={Eye} label="viewed" />
                <dd>
                  <ViewedProgress viewed={viewed.size} total={scan.files.length} />
                </dd>
              </>
            )}
          </dl>
          <div className="row">
            {!isPatch && (
              <button type="button" className="secondary" onClick={rescan} disabled={scan.scanning || pr?.refreshing}>
                <RefreshCw size={12} aria-hidden />
                {pr ? (pr.refreshing ? 'refreshing…' : 'refresh') : scan.scanning ? 'scanning…' : 'rescan'}
              </button>
            )}
            <button type="button" className="secondary" onClick={exportReport} disabled={!scan.files}>
              <Download size={12} aria-hidden />
              export
            </button>
            {!isPatch && (
              <button type="button" className="secondary" onClick={() => setPushOpen(true)} disabled={!repo.owner} title="Push open notes as a pending review">
                <GitPullRequestArrow size={12} aria-hidden />
                push
              </button>
            )}
            {pr && (
              <button type="button" onClick={() => setSubmitOpen(true)} title="Approve, request changes or comment">
                <Send size={12} aria-hidden />
                submit review
              </button>
            )}
          </div>
          {isPatch ? (
            <p className="muted">Read-only. Lines outside the patch’s hunks are not in the file, so they show blank. Notes stay on this device.</p>
          ) : (
            <ClaudeActions session={session} repo={repo} pr={pr && { number: pr.snapshot.pull.number, headRef: pr.snapshot.pull.headRef }} notes={notes} />
          )}
          {scan.renamesLimited && (
            <p className="muted" title="Too many added and deleted files to compare their contents">
              Only identical renames were detected.
            </p>
          )}
          {exportError && <p className="error">{exportError}</p>}
        </div>
        <div className="tabs" role="tablist">
          <TabButton tab="files" current={tab} onSelect={setTab} icon={Files} label={`files ${display.files?.length ?? ''}`} />
          <TabButton
            tab="notes"
            current={tab}
            onSelect={setTab}
            icon={MessageSquare}
            label={`notes ${openNotes || ''}`}
            extra={suggested ? `+${suggested}` : undefined}
          />
          <TabButton
            tab="checklists"
            current={tab}
            onSelect={setTab}
            icon={ListChecks}
            label={items.length ? `checks ${ticked}/${items.length}` : 'checks'}
          />
          {pr && <TabButton tab="conversation" current={tab} onSelect={setTab} icon={MessagesSquare} label="comments" />}
        </div>
        {scan.error && <p className="error panel-message">{scan.error}</p>}
        {tab === 'files' && display.error && display.error !== scan.error && <p className="error panel-message">{display.error}</p>}
        {tab === 'files' && !display.files && display.scanning && <p className="muted panel-message">Loading…</p>}
        {tab === 'files' && display.files && (
          <FileList
            files={shownFiles}
            total={display.files.length}
            filter={filter}
            onFilterChange={setFilter}
            filterRef={filterRef}
            stats={display.stats}
            selected={selected?.path ?? null}
            noteCounts={noteCounts}
            viewed={viewed}
            onSelect={(path) => goToFile(path)}
            dirtyPath={dirtyPath}
            onToggleViewed={toggleViewed}
            order={order}
            onOrderChange={prefs.setOrder}
            risks={risks}
            badges={modes.badges}
            canView={branchWide ? undefined : (path) => modes.branchChange(path) !== null}
            onOpenWindow={openWindow}
          />
        )}
        {tab === 'notes' && <NotesPanel notes={notes} selectedId={focus?.id ?? null} onSelect={jumpTo} />}
        {tab === 'checklists' && <SessionChecklists sessionId={sessionId} repoId={repo.id!} />}
        {tab === 'conversation' && pr && <ConversationPanel pull={pr.snapshot.pull} state={pr.conversation} />}
      </aside>
      <section className={showEditor ? 'session-content editing' : 'session-content'}>
        {editorChange && editSource && (
          <Suspense fallback={showEditor && <p className="diff-notice muted">Loading the editor…</p>}>
            <EditorPane
              key={editorChange.path}
              change={editorChange}
              source={editSource}
              hidden={!showEditor}
              dirty={dirtyPath === editorChange.path}
              dirtyElsewhere={dirtyElsewhere.has(editorChange.path)}
              onDirtyChange={(dirty) => setDirtyPath((current) => (dirty ? editorChange.path : current === editorChange.path ? null : current))}
              onSaved={onSaved}
              onShowDiff={() => setEditing(false)}
            />
          </Suspense>
        )}
        {!showEditor && (
          <>
            {isLocal && <BaseBanner state={freshness} session={session} repo={repo} />}
            {pr && <PrHeader snapshot={pr.snapshot} conversation={pr.conversation} pendingReview={pr.threads.data?.pendingReview ?? null} />}
            {pr?.threads.error && <p className="diff-notice error">Review threads: {pr.threads.error}</p>}
            {!bannerDismissed && modes.lastLook.headChange && modes.lastLook.counts && (
              <SinceBanner
                change={modes.lastLook.headChange}
                counts={modes.lastLook.counts}
                active={modes.mode.kind === 'since'}
                onShow={() => switchMode({ kind: 'since' })}
                onDismiss={() => setBannerDismissed(true)}
              />
            )}
            {!isPatch && scan.files && scan.files.length > 0 && (
              <ModeBar
                mode={modes.mode}
                onModeChange={(next) => switchMode(next)}
                counts={modes.lastLook.counts}
                showUnchanged={modes.showUnchanged}
                onShowUnchangedChange={modes.setShowUnchanged}
                commits={modes.commits}
                range={modes.range}
                onPickCommit={(index, extend) => {
                  modes.pickCommit(index, extend)
                  setNavRequest(null)
                }}
                isPr={pr !== null}
              />
            )}
            {selected ? (
              <FilePane
                key={`${display.source.key}:${selected.path}`}
                sessionId={sessionId}
                source={display.source}
                threads={fileThreads}
                threadActions={threadActions}
                change={selected}
                notes={fileNotes}
                mode={mode}
                onModeChange={changeMode}
                ignoreWhitespace={ignoreWhitespace}
                onIgnoreWhitespaceChange={toggleWhitespace}
                moved={display.moved[selected.path]}
                onOpenMoved={openMoved}
                ci={ci}
                generation={generation}
                viewed={viewed.has(selected.path)}
                onToggleViewed={() => toggleViewed(selected)}
                focus={focus}
                navRequest={navRequest}
                onBoundary={onBoundary}
                noteView={modes.noteViewFor(selected.path)}
                finalLines={modes.finalLines}
                collapseViewed={branchWide}
                viewedDisabled={!branchWide && modes.branchChange(selected.path) === null}
                onNoteRefused={(message) => announce(message, { visible: true })}
                edit={{ onEdit: () => setEditing(true), blocked: editBlocked, dirty: dirtyPath === selected.path }}
                onOpenWindow={() => openWindow(selected.path)}
              />
            ) : branchWide && selectedPath && fileNotes.length > 0 && scan.files ? (
              <OrphanPane path={selectedPath} notes={fileNotes} focus={focus} />
            ) : (
              !display.scanning && (
                <p className="diff-notice muted">
                  {modes.mode.kind === 'since' && display.files?.length === 0 ? 'Nothing changed since your last look.' : 'Select a file.'}
                </p>
              )
            )}
          </>
        )}
      </section>
      {pushOpen && (
        <PushDialog
          session={session}
          notes={notes}
          target={pr ? prPushTarget(pr.gh, pr.snapshot, pr.threads.reload) : localPushTarget(session, repo, scan.files)}
          onClose={() => setPushOpen(false)}
        />
      )}
      {submitOpen && pr && (
        <SubmitReviewDialog
          sessionId={sessionId}
          gh={pr.gh}
          snapshot={pr.snapshot}
          notes={notes}
          pending={pr.threads.data?.pendingReview ?? null}
          viewer={pr.threads.data?.viewer ?? null}
          reviewedFiles={scan.files ?? undefined}
          onClose={() => setSubmitOpen(false)}
        />
      )}
    </div>
  )
}

interface TabButtonProps {
  tab: Tab
  current: Tab
  onSelect: (tab: Tab) => void
  icon: LucideIcon
  label: string
  extra?: string
}

function TabButton({ tab, current, onSelect, icon: Icon, label, extra }: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={tab === current}
      onClick={() => onSelect(tab)}
      title={withShortcut(`${tab[0]!.toUpperCase()}${tab.slice(1)} tab`, TAB_SHORTCUTS[tab])}
    >
      <Icon size={12} aria-hidden />
      {label}
      {extra && <span className="tab-extra">{extra}</span>}
    </button>
  )
}

function MetaLabel({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <dt>
      <Icon size={12} aria-hidden />
      {label}
    </dt>
  )
}

/** One block per file while they fit; a bar beyond that. */
const MAX_BLOCKS = 16

function ViewedProgress({ viewed, total }: { viewed: number; total: number }) {
  return (
    <span className="viewed-blocks" title={`${viewed} of ${total} files viewed`}>
      {total <= MAX_BLOCKS ? (
        <span className="viewed-bar" aria-hidden="true">
          {Array.from({ length: total }, (_, index) => (
            <span key={index} className={index < viewed ? 'on' : undefined} />
          ))}
        </span>
      ) : (
        <span className="viewed-bar continuous" aria-hidden="true">
          <span style={{ width: `${(viewed / total) * 100}%` }} />
        </span>
      )}
      {viewed}/{total}
    </span>
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
    <span className="counts">
      {files.length} {files.length === 1 ? 'file' : 'files'} <span className="add">+{additions}</span>
      <span className="del">−{deletions}</span>
    </span>
  )
}
