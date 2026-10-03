import { useMemo } from 'react'
import type { FileContents, FileSide } from '../git/types'
import { DiffTable, type LineAnnotations, type MovedLines, type ViewMode } from './DiffTable'
import { buildLines } from './hunks'
import { lineEndingChange, type LineEndingChange } from './lineEndings'
import { useHighlight } from './useHighlight'
import { createWordDiffer } from './wordDiff'

export interface DiffOptions {
  mode: ViewMode
  ignoreWhitespace: boolean
  /** Turns whitespace changes back on, from the "only whitespace changed" notice. */
  onShowWhitespace: () => void
}

interface DiffViewerProps extends DiffOptions {
  contents: FileContents
  onLoadLarge: () => void
  moved?: MovedLines
  annotations?: LineAnnotations
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const textOf = (side: FileSide | null) => (side?.kind === 'text' ? side.text : '')

export function DiffViewer({ contents, onLoadLarge, ...rest }: DiffViewerProps) {
  const sides = [contents.old, contents.new]

  if (sides.some((side) => side?.kind === 'binary')) {
    return (
      <p className="diff-notice muted">
        Binary file. {sizeSummary(contents)}
      </p>
    )
  }
  if (sides.some((side) => side?.kind === 'too-large')) {
    return (
      <div className="diff-notice">
        <p className="muted">Large file. {sizeSummary(contents)}</p>
        <button type="button" className="secondary" onClick={onLoadLarge}>
          Load diff anyway
        </button>
      </div>
    )
  }
  return (
    <TextDiff path={contents.path} oldText={textOf(contents.old)} newText={textOf(contents.new)} {...rest} />
  )
}

function sizeSummary({ old, new: next }: FileContents): string {
  if (old && next) return `${formatBytes(old.size)} → ${formatBytes(next.size)}`
  if (next) return `${formatBytes(next.size)} added`
  return old ? `${formatBytes(old.size)} deleted` : ''
}

interface TextDiffProps extends DiffOptions {
  path: string
  oldText: string
  newText: string
  moved?: MovedLines
  annotations?: LineAnnotations
}

function TextDiff({ path, oldText, newText, mode, ignoreWhitespace, onShowWhitespace, moved, annotations }: TextDiffProps) {
  const lines = useMemo(() => buildLines(oldText, newText, { ignoreWhitespace }), [oldText, newText, ignoreWhitespace])
  const words = useMemo(() => createWordDiffer(lines), [lines])
  const endings = useMemo(() => lineEndingChange(oldText, newText), [oldText, newText])
  const tokens = useHighlight(path, oldText, newText)
  if (lines.length === 0) return <p className="diff-notice muted">Empty file.</p>
  if (endings?.only && !ignoreWhitespace) return <p className="diff-notice muted">{describeEndings(endings)} Nothing else changed.</p>
  const table = <DiffTable key={path} lines={lines} mode={mode} tokens={tokens} words={words} moved={moved} annotations={annotations} />
  if (lines.every((line) => line.kind === 'context')) {
    // Notes on a file whose only changes are hidden still need their lines.
    const pinned = (annotations?.pinned.size ?? 0) > 0
    return (
      <>
        {ignoreWhitespace ? (
          <p className="diff-notice muted">
            Only whitespace changed.{' '}
            <button type="button" className="link" onClick={onShowWhitespace}>
              Show whitespace changes
            </button>
          </p>
        ) : (
          <p className="diff-notice muted">No line changes (whitespace, line endings or mode only).</p>
        )}
        {pinned && table}
      </>
    )
  }
  return (
    <>
      {endings && !ignoreWhitespace && (
        <p className="diff-notice muted">
          {describeEndings(endings)} Lines that differ only by their ending show as removed and added.
        </p>
      )}
      {table}
    </>
  )
}

function describeEndings({ from, to }: LineEndingChange): string {
  return `Line endings changed from ${from} to ${to}.`
}
