import { useMemo } from 'react'
import type { FileContents, FileSide } from '../git/types'
import { DiffTable, type LineAnnotations, type ViewMode } from './DiffTable'
import { buildLines } from './hunks'
import { useHighlight } from './useHighlight'

interface DiffViewerProps {
  contents: FileContents
  mode: ViewMode
  onLoadLarge: () => void
  annotations?: LineAnnotations
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const textOf = (side: FileSide | null) => (side?.kind === 'text' ? side.text : '')

export function DiffViewer({ contents, mode, onLoadLarge, annotations }: DiffViewerProps) {
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
    <TextDiff
      path={contents.path}
      oldText={textOf(contents.old)}
      newText={textOf(contents.new)}
      mode={mode}
      annotations={annotations}
    />
  )
}

function sizeSummary({ old, new: next }: FileContents): string {
  if (old && next) return `${formatBytes(old.size)} → ${formatBytes(next.size)}`
  if (next) return `${formatBytes(next.size)} added`
  return old ? `${formatBytes(old.size)} deleted` : ''
}

interface TextDiffProps {
  path: string
  oldText: string
  newText: string
  mode: ViewMode
  annotations?: LineAnnotations
}

function TextDiff({ path, oldText, newText, mode, annotations }: TextDiffProps) {
  const lines = useMemo(() => buildLines(oldText, newText), [oldText, newText])
  const tokens = useHighlight(path, oldText, newText)
  if (lines.length === 0) return <p className="diff-notice muted">Empty file.</p>
  if (lines.every((line) => line.kind === 'context')) {
    return <p className="diff-notice muted">No line changes (whitespace, line endings or mode only).</p>
  }
  return <DiffTable key={path} lines={lines} mode={mode} tokens={tokens} annotations={annotations} />
}
