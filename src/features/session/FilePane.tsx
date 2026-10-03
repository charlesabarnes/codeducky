import { useEffect, useMemo, useRef, useState } from 'react'
import type { Note } from '../../db/schema'
import type { ViewMode } from '../../diff/DiffTable'
import { DiffViewer } from '../../diff/DiffViewer'
import type { FileChange } from '../../git/types'
import { sideLines } from '../../review/lines'
import { LostNotes } from '../notes/LostNotes'
import { useNoteAnnotations } from '../notes/useNoteAnnotations'
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
  generation: number
  viewed: boolean
  onToggleViewed: () => void
  focus: NoteFocus | null
}

export function FilePane(props: FilePaneProps) {
  const { sessionId, change, notes, mode, onModeChange, generation, viewed, onToggleViewed, focus } = props
  const { contents, error, loading, loadLarge } = useFileContents(change, generation)
  const lines = useMemo(
    () => ({ old: sideLines(contents?.old ?? null), new: sideLines(contents?.new ?? null) }),
    [contents],
  )
  const focusedId = focus && notes.some((note) => note.id === focus.id) ? focus.id : null
  const annotations = useNoteAnnotations({ sessionId, path: change.path, notes, lines, focusedId })
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const paneKey = `${change.path}:${change.oldOid}:${change.newOid}`
  const collapsed = viewed && expandedKey !== paneKey && focusedId === null
  const lost = notes.filter((note) => note.anchorLost && note.status !== 'dismissed')

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
      <div className="diff-toolbar">
        <span className="path mono">{change.path}</span>
        <label className="viewed-toggle">
          <input type="checkbox" checked={viewed} onChange={onToggleViewed} /> Viewed
        </label>
        <div className="segmented" role="group" aria-label="Diff layout">
          {(['unified', 'split'] as const).map((option) => (
            <button key={option} type="button" aria-pressed={mode === option} onClick={() => onModeChange(option)}>
              {option === 'unified' ? 'Unified' : 'Split'}
            </button>
          ))}
        </div>
      </div>
      <LostNotes notes={lost} heading="Possibly resolved: the anchored line is gone" focusedId={focusedId} />
      {collapsed ? (
        <p className="diff-notice muted">
          Marked as viewed.{' '}
          <button type="button" className="link" onClick={() => setExpandedKey(paneKey)}>
            Show diff
          </button>
        </p>
      ) : (
        <>
          {error && <p className="diff-notice error">{error}</p>}
          {loading && <p className="diff-notice muted">Loading…</p>}
          {contents && (
            <DiffViewer contents={contents} mode={mode} onLoadLarge={loadLarge} annotations={annotations} />
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
