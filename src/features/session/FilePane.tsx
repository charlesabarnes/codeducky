import { useEffect, useMemo, useRef, useState } from 'react'
import type { Note } from '../../db/schema'
import type { ViewMode } from '../../diff/DiffTable'
import { DiffViewer } from '../../diff/DiffViewer'
import type { MoveTarget, MovedRange } from '../../diff/moved'
import type { FileChange } from '../../git/types'
import { useShortcuts } from '../../keys/context'
import { DiffNavContext, type DiffNavApi, type NavRequest } from '../../keys/diffNavContext'
import { withShortcut } from '../../keys/help'
import { sideLines } from '../../review/lines'
import { UnplacedAnnotations } from '../ci/CiAnnotationCard'
import { useCiAnnotations } from '../ci/useCiAnnotations'
import type { CiView } from '../ci/useCiStatus'
import { LostNotes } from '../notes/LostNotes'
import { useNoteAnnotations } from '../notes/useNoteAnnotations'
import { renameLabel } from './renames'
import { useFileContents } from './useFileContents'

export interface NoteFocus {
  id: string
  at: number
}

interface FilePaneProps {
  sessionId: string
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
}

export function FilePane(props: FilePaneProps) {
  const { sessionId, change, notes, mode, onModeChange, generation, viewed, onToggleViewed, focus } = props
  const { navRequest, onBoundary, ignoreWhitespace, onIgnoreWhitespaceChange, moved, onOpenMoved, ci } = props
  const { contents, error, loading, loadLarge } = useFileContents(change, generation)
  const lines = useMemo(
    () => ({ old: sideLines(contents?.old ?? null), new: sideLines(contents?.new ?? null) }),
    [contents],
  )
  const focusedId = focus && notes.some((note) => note.id === focus.id) ? focus.id : null
  const noteAnnotations = useNoteAnnotations({ sessionId, path: change.path, notes, lines, focusedId })
  const { annotations, placed } = useCiAnnotations(ci, change.path, lines.new?.length ?? null, noteAnnotations)
  const movedLines = useMemo(() => (moved?.length ? { ranges: moved, onOpen: onOpenMoved } : undefined), [moved, onOpenMoved])
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const paneKey = `${change.path}:${change.oldOid}:${change.newOid}`
  const collapsed = viewed && expandedKey !== paneKey && focusedId === null
  const lost = notes.filter((note) => note.anchorLost && note.status !== 'dismissed')

  const focusedNote = focusedId === null ? undefined : notes.find((note) => note.id === focusedId)
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

  return (
    <>
      <div className="diff-toolbar" data-sticky-header>
        <span className="path mono" title={change.oldPath ? `Renamed from ${change.oldPath}` : undefined}>
          {change.oldPath ? renameLabel(change.oldPath, change.path) : change.path}
          {change.oldPath && <span className="rename-from"> · renamed, {change.similarity}% similar</span>}
        </span>
        <button
          type="button"
          className="secondary toolbar-toggle"
          aria-pressed={ignoreWhitespace}
          aria-keyshortcuts="w"
          title={withShortcut(ignoreWhitespace ? 'Show whitespace changes' : 'Hide whitespace changes', 'view.whitespace')}
          onClick={() => onIgnoreWhitespaceChange(!ignoreWhitespace)}
        >
          Hide whitespace
        </button>
        <label className="viewed-toggle" title={withShortcut('Viewed', 'file.viewed')}>
          <input type="checkbox" checked={viewed} onChange={onToggleViewed} aria-keyshortcuts="v" /> Viewed
        </label>
        <div className="segmented" role="group" aria-label="Diff layout" title={withShortcut('Switch layout', 'view.mode')}>
          {(['unified', 'split'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={mode === option}
              aria-keyshortcuts="s"
              onClick={() => onModeChange(option)}
            >
              {option === 'unified' ? 'Unified' : 'Split'}
            </button>
          ))}
        </div>
      </div>
      <LostNotes notes={lost} heading="Possibly resolved: the anchored line is gone" focusedId={focusedId} />
      {!collapsed && <UnplacedAnnotations items={placed.unplaced} runs={ci.runs} />}
      {collapsed ? (
        <p className="diff-notice muted">
          Marked as viewed.{' '}
          <button type="button" className="link" onClick={() => setExpandedKey(paneKey)} title="Show diff (j)">
            Show diff
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
        <span className="path mono">{path}</span>
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
