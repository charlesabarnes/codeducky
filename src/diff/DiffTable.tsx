import { Fragment, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { CodeText } from './CodeText'
import {
  buildSegments,
  DEFAULT_CONTEXT,
  limitBlocks,
  lineOn,
  toSplitRows,
  visibleBlocks,
  type DiffLine,
  type DiffSide,
  type GapExpansion,
} from './hunks'
import type { SideTokens } from './useHighlight'

export type ViewMode = 'unified' | 'split'

const EXPAND_STEP = 20
const RENDER_STEP = 2000
const MARKERS = { add: '+', del: '-', context: ' ' } as const
const NO_PINS: ReadonlySet<string> = new Set()

export interface LineAnnotations {
  pinned: ReadonlySet<string>
  render: (side: DiffSide, line: number) => ReactNode
  onSelect?: (side: DiffSide, line: number) => void
}

interface DiffTableProps {
  lines: DiffLine[]
  mode: ViewMode
  tokens: SideTokens
  annotations?: LineAnnotations
}

interface RowsProps {
  lines: DiffLine[]
  tokens: SideTokens
  annotations?: LineAnnotations
}

function selectHandler(annotations: LineAnnotations | undefined, side: DiffSide, line: DiffLine | null) {
  const number = line ? lineOn(line, side) : null
  const onSelect = annotations?.onSelect
  if (!onSelect || number === null) return undefined
  return (event: MouseEvent) => {
    const selection = window.getSelection()
    if ((event.target as HTMLElement).closest('.code') && selection && !selection.isCollapsed) return
    onSelect(side, number)
  }
}

function annotationFor(annotations: LineAnnotations | undefined, side: DiffSide, line: DiffLine | null): ReactNode {
  const number = line ? lineOn(line, side) : null
  return annotations && number !== null ? annotations.render(side, number) : null
}

export function DiffTable({ lines, mode, tokens, annotations }: DiffTableProps) {
  const pinned = annotations?.pinned ?? NO_PINS
  const segments = useMemo(() => buildSegments(lines, DEFAULT_CONTEXT, pinned), [lines, pinned])
  const [expanded, setExpanded] = useState<Map<number, GapExpansion>>(new Map())
  const [renderLimit, setRenderLimit] = useState(RENDER_STEP)
  const { blocks, remaining } = useMemo(
    () => limitBlocks(visibleBlocks(segments, expanded), renderLimit),
    [segments, expanded, renderLimit],
  )
  const columns = mode === 'split' ? 6 : 4

  const expand = (id: number, change: Partial<GapExpansion> | 'all') => {
    setExpanded((current) => {
      const next = new Map(current)
      const previous = next.get(id) ?? { top: 0, bottom: 0 }
      next.set(
        id,
        change === 'all'
          ? { top: Number.MAX_SAFE_INTEGER, bottom: 0 }
          : { top: previous.top + (change.top ?? 0), bottom: previous.bottom + (change.bottom ?? 0) },
      )
      return next
    })
  }

  return (
    <table className={annotations?.onSelect ? 'diff-table selectable' : 'diff-table'}>
      {mode === 'split' ? (
        <colgroup>
          <col className="ln" style={{ width: '3.5rem' }} />
          <col style={{ width: '1.25rem' }} />
          <col />
          <col style={{ width: '3.5rem' }} />
          <col style={{ width: '1.25rem' }} />
          <col />
        </colgroup>
      ) : (
        <colgroup>
          <col style={{ width: '3.5rem' }} />
          <col style={{ width: '3.5rem' }} />
          <col style={{ width: '1.25rem' }} />
          <col />
        </colgroup>
      )}
      <tbody>
        {blocks.map((block, index) =>
          block.type === 'gap' ? (
            <GapRow
              key={`gap-${block.id}`}
              hidden={block.hidden}
              columns={columns}
              isFirst={index === 0}
              isLast={index === blocks.length - 1}
              onExpand={(change) => expand(block.id, change)}
            />
          ) : (
            <Fragment key={`lines-${index}`}>
              {mode === 'split' ? (
                <SplitRows lines={block.lines} tokens={tokens} annotations={annotations} />
              ) : (
                <UnifiedRows lines={block.lines} tokens={tokens} annotations={annotations} />
              )}
            </Fragment>
          ),
        )}
        {remaining > 0 && (
          <tr className="gap">
            <td colSpan={columns}>
              <div className="gap-controls">
                <button type="button" className="link" onClick={() => setRenderLimit((n) => n + RENDER_STEP)}>
                  Show {Math.min(RENDER_STEP, remaining)} more lines
                </button>
                <button type="button" className="link" onClick={() => setRenderLimit(Number.MAX_SAFE_INTEGER)}>
                  Show all {remaining} remaining lines
                </button>
              </div>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

function UnifiedRows({ lines, tokens, annotations }: RowsProps) {
  return lines.map((line, index) => {
    const oldNote = annotationFor(annotations, 'old', line)
    const newNote = annotationFor(annotations, 'new', line)
    const codeSide = line.kind === 'del' ? 'old' : 'new'
    return (
      <Fragment key={index}>
        <tr className={line.kind}>
          <td className="ln" onClick={selectHandler(annotations, 'old', line)}>
            {line.oldNo}
          </td>
          <td className="ln" onClick={selectHandler(annotations, 'new', line)}>
            {line.newNo}
          </td>
          <td className="marker">{MARKERS[line.kind]}</td>
          <td className="code" onClick={selectHandler(annotations, codeSide, line)}>
            <CodeText line={line} tokens={tokens} />
          </td>
        </tr>
        {(oldNote || newNote) && (
          <tr className="annotation">
            <td colSpan={4}>
              {oldNote}
              {newNote}
            </td>
          </tr>
        )}
      </Fragment>
    )
  })
}

function SplitRows({ lines, tokens, annotations }: RowsProps) {
  return toSplitRows(lines).map(({ left, right }, index) => {
    const oldNote = annotationFor(annotations, 'old', left)
    const newNote = annotationFor(annotations, 'new', right)
    return (
      <Fragment key={index}>
        <tr>
          <SplitCells line={left} side="old" tokens={tokens} annotations={annotations} />
          <SplitCells line={right} side="new" tokens={tokens} annotations={annotations} divider />
        </tr>
        {(oldNote || newNote) && (
          <tr className="annotation">
            <td colSpan={3}>{oldNote}</td>
            <td colSpan={3} className="split-divider">
              {newNote}
            </td>
          </tr>
        )}
      </Fragment>
    )
  })
}

interface SplitCellsProps {
  line: DiffLine | null
  side: DiffSide
  tokens: SideTokens
  annotations?: LineAnnotations
  divider?: boolean
}

function SplitCells({ line, side, tokens, annotations, divider }: SplitCellsProps) {
  const kind = line ? line.kind : 'empty'
  const edge = divider ? ' split-divider' : ''
  const onSelect = selectHandler(annotations, side, line)
  return (
    <>
      <td className={`ln ${kind}${edge}`} onClick={onSelect}>
        {line ? (side === 'old' ? line.oldNo : line.newNo) : null}
      </td>
      <td className={`marker ${kind}`}>{line ? MARKERS[line.kind] : null}</td>
      <td className={`code ${kind}`} onClick={onSelect}>
        {line && <CodeText line={line} tokens={tokens} />}
      </td>
    </>
  )
}

interface GapRowProps {
  hidden: number
  columns: number
  isFirst: boolean
  isLast: boolean
  onExpand: (change: Partial<GapExpansion> | 'all') => void
}

function GapRow({ hidden, columns, isFirst, isLast, onExpand }: GapRowProps) {
  const step = Math.min(EXPAND_STEP, hidden)
  return (
    <tr className="gap">
      <td colSpan={columns}>
        <div className="gap-controls">
          {!isFirst && hidden > EXPAND_STEP && (
            <button type="button" className="link" onClick={() => onExpand({ top: step })}>
              ↓ Expand {step}
            </button>
          )}
          {!isLast && hidden > EXPAND_STEP && (
            <button type="button" className="link" onClick={() => onExpand({ bottom: step })}>
              ↑ Expand {step}
            </button>
          )}
          <button type="button" className="link" onClick={() => onExpand('all')}>
            Expand {hidden} unchanged {hidden === 1 ? 'line' : 'lines'}
          </button>
        </div>
      </td>
    </tr>
  )
}
