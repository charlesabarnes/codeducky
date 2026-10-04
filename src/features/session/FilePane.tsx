import { Columns2, Pilcrow, Rows2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Note } from '../../db/schema'
import type { ViewMode } from '../../diff/DiffTable'
import { DiffViewer } from '../../diff/DiffViewer'
import type { MoveTarget, MovedRange } from '../../diff/moved'
import type { FileChange } from '../../git/types'
import { useShortcuts } from '../../keys/context'
import { DiffNavContext, type DiffNavApi, type NavRequest } from '../../keys/diffNavContext'
import { withShortcut } from '../../keys/help'
import { sideLines, type NumberedLine } from '../../review/lines'
import { anchorForView, placeNotes, type NoteView } from '../../review/viewNotes'
import { UnplacedAnnotations } from '../ci/CiAnnotationCard'
import { useCiAnnotations } from '../ci/useCiAnnotations'
import type { CiView } from '../ci/useCiStatus'
import { LostNotes } from '../notes/LostNotes'
import { useNoteAnnotations } from '../notes/useNoteAnnotations'
import type { ReviewThread } from '../../github/threads'
import { ThreadCard, type ThreadActions } from '../pr/ThreadCard'
import { useThreadAnnotations } from '../pr/useThreadAnnotations'
import { SplitPath } from './FileList'
import type { DiffSource } from './source'
import { useFileContents } from './useFileContents'
import { ViewToggle } from '../editor/ViewToggle'

export interface NoteFocus {
  id: string
  at: number
}

interface FilePaneProps {
  sessionId: string
  source: DiffSource
  /** Review threads on this file, in a pull request session. */
  threads: ReviewThread[] | null
  threadActions: ThreadActions | null
  change: FileChange
  notes: Note[]
  mode: ViewMode
  onModeChange: (mode: ViewMode) => void
  ignoreWhitespace: boolean
  onIgnoreWhitespaceChange: (ignore: boolean) => void
  /** Blocks of this file that moved, from the whole-change-set scan. */
  moved: readonly MovedRange[] | undefined
  onOpenMoved: (target: MoveTarget) => void
  ci: CiView
  generation: number
  viewed: boolean
  onToggleViewed: () => void
  focus: NoteFocus | null
  /** Where the keyboard cursor should start, e.g. after n/p crossed into this file. */
  navRequest: NavRequest | null
  onBoundary: (direction: 1 | -1) => boolean
  /** What this diff is (the whole branch, an interdiff, a commit), for placing and anchoring notes. */
  noteView?: NoteView
  /** The file's final content, for anchoring notes made on a commit. */
  finalLines?: (path: string) => Promise<NumberedLine[] | null>
  /** Viewed files fold away in the branch-wide view only. */
  collapseViewed?: boolean
  /** The file is not in the branch's final diff, so there is nothing to mark viewed. */
  viewedDisabled?: boolean
  /** Says why a note cannot be made where it was asked for. */
  onNoteRefused?: (message: string) => void
  /** Opens the file in the editor; `blocked` says why it cannot be. */
  edit?: { onEdit: () => void; blocked: string | null; dirty: boolean }
}

const ALL: NoteView = { kind: 'all' }

export function FilePane(props: FilePaneProps) {
  const { sessionId, change, notes, mode, onModeChange, generation, viewed, onToggleViewed, focus } = props
  const { navRequest, onBoundary, ignoreWhitespace, onIgnoreWhitespaceChange, moved, onOpenMoved, ci } = props
  const { source, threads, threadActions, finalLines, collapseViewed = true, viewedDisabled, onNoteRefused, edit } = props
  const { contents, error, loading, loadLarge } = useFileContents(source, change, generation)
  const lines = useMemo(
    () => ({ old: sideLines(contents?.old ?? null), new: sideLines(contents?.new ?? null) }),
    [contents],
  )
  const viewKey = props.noteView ? JSON.stringify(props.noteView) : 'all'
  const noteView = useMemo<NoteView>(() => (viewKey === 'all' ? ALL : (JSON.parse(viewKey) as NoteView)), [viewKey])
  const placement = useMemo(() => placeNotes(notes, lines.new, noteView), [notes, lines.new, noteView])
  const focusedId = focus && placement.placed.some((note) => note.id === focus.id) ? focus.id : null
  const branchWide = noteView.kind === 'all'
  const noteAnnotations = useNoteAnnotations({
    sessionId,
    path: change.path,
    notes: placement.placed,
    lines,
    focusedId,
    anchorFor: branchWide
      ? undefined
      : async (side, line) =>
          anchorForView(noteView, side, line, lines, noteView.kind === 'commit' && finalLines ? await finalLines(change.path) : null),
    refuseSide: branchWide
      ? undefined
      : (side) => (side === 'old' ? 'In this view, comment on the new (right-hand) side. Base lines take notes in All changes.' : null),
    onRefuse: onNoteRefused,
  })
  const withCi = useCiAnnotations(ci, change.path, lines.new?.length ?? null, noteAnnotations)
  const placed = withCi.placed
  const { annotations, listed: listedThreads } = useThreadAnnotations(threads, threadActions, withCi.annotations)
  const threadFocused = threadActions?.focusedId != null && (threads ?? []).some((thread) => thread.id === threadActions.focusedId)
  const movedLines = useMemo(() => (moved?.length ? { ranges: moved, onOpen: onOpenMoved } : undefined), [moved, onOpenMoved])
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const paneKey = `${change.path}:${change.oldOid}:${change.newOid}`
  const collapsed = collapseViewed && viewed && expandedKey !== paneKey && focusedId === null && !threadFocused
  const lost = placement.placed.filter((note) => note.anchorLost && note.status !== 'dismissed')
  const elsewhere = placement.elsewhere.filter((note) => note.status !== 'dismissed')

  const focusedNote = focusedId === null ? undefined : placement.placed.find((note) => note.id === focusedId)
  const noteRequest = useMemo<NavRequest | null>(
    () =>
      focus && focusedNote && !focusedNote.anchorLost
        ? { at: focus.at, target: { side: focusedNote.anchor.side, line: focusedNote.anchor.line } }
        : null,
    [focus, focusedNote],
  )
  const request = noteRequest && (!navRequest || noteRequest.at > navRequest.at) ? noteRequest : navRequest
  const nav = useMemo<DiffNavApi>(() => ({ request, onBoundary }), [request, onBoundary])

  // Fallbacks for when no diff is on screen (collapsed, binary or too large); the diff's own
  // handlers take precedence whenever it is shown.
  const expandCollapsed = () => {
    if (!collapsed) return false
    setExpandedKey(paneKey)
  }
  useShortcuts('file', {
    'line.next': expandCollapsed,
    'line.prev': expandCollapsed,
    'change.next': expandCollapsed,
    'change.prev': expandCollapsed,
    'hunk.next': () => onBoundary(1),
    'hunk.prev': () => onBoundary(-1),
  })

  const scrolled = useRef<NoteFocus | null>(null)
  useEffect(() => {
    if (!focus || focusedId === null || scrolled.current === focus) return
    const element = document.getElementById(`note-${focus.id}`)
    if (!element) return
    element.scrollIntoView({ block: 'center', behavior: 'smooth' })
    scrolled.current = focus
  })

  const scrolledThread = useRef<string | null>(null)
  const focusedThreadId = threadFocused ? threadActions!.focusedId : null
  useEffect(() => {
    if (!focusedThreadId || scrolledThread.current === `${focusedThreadId}:${threadActions?.focusAt}`) return
    const element = document.getElementById(`thread-${focusedThreadId}`)
    if (!element) return
    element.scrollIntoView({ block: 'center' })
    scrolledThread.current = `${focusedThreadId}:${threadActions?.focusAt}`
  })

  return (
    <>
      <div className="diff-toolbar" data-sticky-header>
        <span className="path" title={change.oldPath ? `Renamed from ${change.oldPath}` : undefined}>
          <SplitPath path={change.path} oldPath={change.oldPath} />
          {change.oldPath && (
            <span className="rename-from"> · renamed{change.similarity !== undefined && `, ${change.similarity}% similar`}</span>
          )}
        </span>
        <button
          type="button"
          className="toolbar-toggle"
          aria-pressed={ignoreWhitespace}
          aria-keyshortcuts="w"
          aria-label="Hide whitespace"
          title={withShortcut(ignoreWhitespace ? 'Show whitespace changes' : 'Hide whitespace changes', 'view.whitespace')}
          onClick={() => onIgnoreWhitespaceChange(!ignoreWhitespace)}
        >
          <Pilcrow size={13} aria-hidden />
          {ignoreWhitespace ? 'whitespace hidden' : 'whitespace'} <span className="key">w</span>
        </button>
        <label
          className="viewed-toggle"
          title={
            viewedDisabled
              ? 'Not in the final diff of the branch, so there is nothing to mark viewed'
              : withShortcut(branchWide ? 'Viewed' : 'Viewed (per file for the whole branch)', 'file.viewed')
          }
        >
          <input type="checkbox" checked={viewed} onChange={onToggleViewed} disabled={viewedDisabled} aria-keyshortcuts="v" />
          viewed <span className="key">v</span>
        </label>
        <div className="layout-toggle" title={withShortcut('Switch layout', 'view.mode')}>
          <div className="segmented inverted" role="group" aria-label="Diff layout">
            {(['unified', 'split'] as const).map((option) => (
              <button key={option} type="button" aria-pressed={mode === option} aria-keyshortcuts="s" onClick={() => onModeChange(option)}>
                {option === 'unified' ? <Rows2 size={12} aria-hidden /> : <Columns2 size={12} aria-hidden />}
                {option}
              </button>
            ))}
          </div>
          <span className="key">&nbsp;s</span>
        </div>
        {edit && <ViewToggle editing={false} dirty={edit.dirty} disabledReason={edit.blocked} onChange={(editing) => editing && edit.onEdit()} />}
      </div>
      <LostNotes notes={lost} heading="Possibly resolved: the anchored line is gone" focusedId={focusedId} />
      {elsewhere.length > 0 && (
        <div className="elsewhere-notes">
          <LostNotes
            notes={elsewhere}
            heading={
              noteView.kind === 'all'
                ? 'Notes on earlier commits (pick the commit to see them in place)'
                : 'Notes not on this diff: base lines, lines this view does not show, or another commit'
            }
          />
        </div>
      )}
      {contents?.notice && <p className="base-banner warn">{contents.notice}</p>}
      {threadActions && listedThreads.length > 0 && (
        <section className="listed-threads stack" aria-label="Outdated and file comments">
          <h3>
            Outdated and file comments <span className="muted">({listedThreads.length})</span>
          </h3>
          {listedThreads.map((thread) => (
            <ThreadCard key={thread.id} thread={thread} actions={threadActions} showWhere />
          ))}
        </section>
      )}
      {!collapsed && <UnplacedAnnotations items={placed.unplaced} runs={ci.runs} />}
      {collapsed ? (
        <p className="diff-notice muted">
          Marked as viewed.{' '}
          <button type="button" className="link accent" onClick={() => setExpandedKey(paneKey)} title="Show diff (j)">
            show diff
          </button>
        </p>
      ) : (
        <>
          {error && <p className="diff-notice error">{error}</p>}
          {loading && <p className="diff-notice muted">Loading…</p>}
          {contents && (
            <DiffNavContext.Provider value={nav}>
              <DiffViewer
                contents={contents}
                mode={mode}
                ignoreWhitespace={ignoreWhitespace}
                onShowWhitespace={() => onIgnoreWhitespaceChange(false)}
                onLoadLarge={loadLarge}
                moved={movedLines}
                annotations={annotations}
              />
            </DiffNavContext.Provider>
          )}
        </>
      )}
    </>
  )
}

export function OrphanPane({ path, notes, focus }: { path: string; notes: Note[]; focus: NoteFocus | null }) {
  return (
    <>
      <div className="diff-toolbar">
        <span className="path">
          <SplitPath path={path} />
        </span>
      </div>
      <p className="diff-notice muted">This file no longer differs from the base.</p>
      <LostNotes
        notes={notes.filter((note) => note.status !== 'dismissed')}
        heading="Notes on this file"
        focusedId={focus?.id ?? null}
      />
    </>
  )
}
