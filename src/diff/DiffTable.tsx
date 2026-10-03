import { Fragment, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import type { Cursor } from '../keys/diffNav'
import type { LineActions } from '../keys/lineActions'
import { useDiffNavigation } from '../keys/useDiffNavigation'
import { CodeText } from './CodeText'
import './diff.css'
import { movedAt, type MoveTarget, type MovedRange } from './moved'
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
import type { WordDiffer } from './wordDiff'

export type ViewMode = 'unified' | 'split'

const EXPAND_STEP = 20
const RENDER_STEP = 2000
const MARKERS = { add: '+', del: '-', context: ' ' } as const
const NO_PINS: ReadonlySet<string> = new Set()

export interface LineAnnotations {
  pinned: ReadonlySet<string>
  render: (side: DiffSide, line: number) => ReactNode
  onSelect?: (side: DiffSide, line: number) => void
  /** Note actions for the keyboard cursor (c, e, r, a, d). */
  actions?: LineActions
}

/** Blocks of this file that moved, and how to follow one to its other half. */
export interface MovedLines {
  ranges: readonly MovedRange[]
  onOpen: (target: MoveTarget) => void
}

interface DiffTableProps {
  lines: DiffLine[]
  mode: ViewMode
  tokens: SideTokens
  words?: WordDiffer
  moved?: MovedLines
  annotations?: LineAnnotations
}

type SelectLine = (side: DiffSide, line: number) => void

interface RowsProps {
  lines: DiffLine[]
  tokens: SideTokens
  words?: WordDiffer
  moved?: MovedLines
  annotations?: LineAnnotations
  focus: Cursor | null
  onSelect: SelectLine
}

/** The moved block a changed line belongs to, if any. */
function movedRange(moved: MovedLines | undefined, line: DiffLine | null): MovedRange | null {
  if (!moved || !line || line.kind === 'context') return null
  return line.kind === 'del' ? movedAt(moved.ranges, 'old', line.oldNo!) : movedAt(moved.ranges, 'new', line.newNo!)
}

function MovedLink({ range, line, onOpen }: { range: MovedRange; line: DiffLine; onOpen: MovedLines['onOpen'] }) {
  const number = range.side === 'old' ? line.oldNo : line.newNo
  if (number !== range.start) return null
  const { other } = range
  const label = `${range.side === 'old' ? 'moved to' : 'moved from'} ${other.path}:${other.line}`
  const count = range.end - range.start + 1
  return (
    <button
      type="button"
      className="moved-link"
      title={`${count} ${count === 1 ? 'line' : 'lines'} ${label}`}
      onClick={(event) => {
        event.stopPropagation()
        onOpen(other)
      }}
    >
      {range.side === 'old' ? '↘' : '↗'} {label}
    </button>
  )
}

function selectHandler(annotations: LineAnnotations | undefined, onSelect: SelectLine, side: DiffSide, line: DiffLine | null) {
  const number = line ? lineOn(line, side) : null
  if (!annotations?.onSelect || number === null) return undefined
  return (event: MouseEvent) => {
    const selection = window.getSelection()
    if ((event.target as HTMLElement).closest('.code') && selection && !selection.isCollapsed) return
    onSelect(side, number)
  }
}

const isFocused = (focus: Cursor | null, side: DiffSide, line: DiffLine | null) =>
  focus !== null && line !== null && focus.side === side && lineOn(line, side) === focus.line

/** Props for the focused row: the visible ring, a hook for scrolling, and its state for assistive tech. */
const focusProps = (focused: boolean) =>
  focused ? { 'data-kbd-focus': '', 'aria-current': 'location' as const } : {}

function annotationFor(annotations: LineAnnotations | undefined, side: DiffSide, line: DiffLine | null): ReactNode {
  const number = line ? lineOn(line, side) : null
  return annotations && number !== null ? annotations.render(side, number) : null
}

export function DiffTable({ lines, mode, tokens, words, moved, annotations }: DiffTableProps) {
  const pinned = annotations?.pinned ?? NO_PINS
  const segments = useMemo(() => buildSegments(lines, DEFAULT_CONTEXT, pinned), [lines, pinned])
  const [expanded, setExpanded] = useState<Map<number, GapExpansion>>(new Map())
  const [renderLimit, setRenderLimit] = useState(RENDER_STEP)
  const { blocks, remaining } = useMemo(
    () => limitBlocks(visibleBlocks(segments, expanded), renderLimit),
    [segments, expanded, renderLimit],
  )
  const columns = mode === 'split' ? 6 : 4
  const { focus, tableRef, select } = useDiffNavigation({
    blocks,
    mode,
    remaining,
    onExpandGap: (id) => expand(id, 'all'),
    onShowMore: () => setRenderLimit((n) => n + RENDER_STEP),
    actions: annotations?.actions,
  })
  const selectLine: SelectLine = (side, line) => {
    select(side, line)
    annotations?.onSelect?.(side, line)
  }
  const rowProps = { tokens, words, moved, annotations, focus, onSelect: selectLine }

  function expand(id: number, change: Partial<GapExpansion> | 'all') {
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
    <table ref={tableRef} className={annotations?.onSelect ? 'diff-table selectable' : 'diff-table'}>
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
                <SplitRows lines={block.lines} {...rowProps} />
              ) : (
                <UnifiedRows lines={block.lines} {...rowProps} />
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

function UnifiedRows({ lines, tokens, words, moved, annotations, focus, onSelect }: RowsProps) {
  return lines.map((line, index) => {
    const oldNote = annotationFor(annotations, 'old', line)
    const newNote = annotationFor(annotations, 'new', line)
    const codeSide = line.kind === 'del' ? 'old' : 'new'
    const focused = isFocused(focus, codeSide, line)
    const range = movedRange(moved, line)
    const className = `${line.kind}${range ? ' moved' : ''}${focused ? ' kbd-focus' : ''}`
    return (
      <Fragment key={index}>
        <tr className={className} {...focusProps(focused)}>
          <td className="ln" onClick={selectHandler(annotations, onSelect, 'old', line)}>
            {line.oldNo}
          </td>
          <td className="ln" onClick={selectHandler(annotations, onSelect, 'new', line)}>
            {line.newNo}
          </td>
          <td className="marker">{MARKERS[line.kind]}</td>
          <td className="code" onClick={selectHandler(annotations, onSelect, codeSide, line)}>
            {range && <MovedLink range={range} line={line} onOpen={moved!.onOpen} />}
            <CodeText line={line} side={codeSide} tokens={tokens} words={words} />
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

function SplitRows({ lines, tokens, words, moved, annotations, focus, onSelect }: RowsProps) {
  return toSplitRows(lines).map(({ left, right }, index) => {
    const oldNote = annotationFor(annotations, 'old', left)
    const newNote = annotationFor(annotations, 'new', right)
    const focusedOld = isFocused(focus, 'old', left)
    const focusedNew = isFocused(focus, 'new', right)
    const cells = { tokens, words, moved, annotations, onSelect }
    return (
      <Fragment key={index}>
        <tr className={focusedOld || focusedNew ? 'kbd-focus' : undefined} {...focusProps(focusedOld || focusedNew)}>
          <SplitCells line={left} side="old" focused={focusedOld} {...cells} />
          <SplitCells line={right} side="new" focused={focusedNew} {...cells} divider />
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
  words?: WordDiffer
  moved?: MovedLines
  annotations?: LineAnnotations
  onSelect: SelectLine
  focused: boolean
  divider?: boolean
}

function SplitCells({ line, side, tokens, words, moved, annotations, onSelect, focused, divider }: SplitCellsProps) {
  const range = movedRange(moved, line)
  const kind = `${line ? line.kind : 'empty'}${range ? ' moved' : ''}`
  const edge = `${divider ? ' split-divider' : ''}${focused ? ' kbd-side' : ''}`
  const select = selectHandler(annotations, onSelect, side, line)
  return (
    <>
      <td className={`ln ${kind}${edge}`} onClick={select}>
        {line ? (side === 'old' ? line.oldNo : line.newNo) : null}
      </td>
      <td className={`marker ${kind}${focused ? ' kbd-side' : ''}`}>{line ? MARKERS[line.kind] : null}</td>
      <td className={`code ${kind}${focused ? ' kbd-side' : ''}`} onClick={select}>
        {range && line && <MovedLink range={range} line={line} onOpen={moved!.onOpen} />}
        {line && <CodeText line={line} side={side} tokens={tokens} words={words} />}
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
