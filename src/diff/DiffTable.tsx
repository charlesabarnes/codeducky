import { UnfoldVertical } from 'lucide-react'
import { Fragment, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import type { Cursor } from '../keys/diffNav'
import type { LineActions } from '../keys/lineActions'
import { inRange, singleLine, type LineRange } from '../keys/selection'
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
import { useLineDrag } from './useLineDrag'
import type { WordDiffer } from './wordDiff'

export type ViewMode = 'unified' | 'split'

const EXPAND_STEP = 20
const RENDER_STEP = 2000
const MARKERS = { add: '+', del: '−', context: ' ' } as const
const NO_PINS: ReadonlySet<string> = new Set()
const LINE_NUMBER_WIDTH = 44
const MARKER_WIDTH = 18

export interface LineAnnotations {
  pinned: ReadonlySet<string>
  render: (side: DiffSide, line: number) => ReactNode
  /** Opens the note editor on a line or range; lines are clickable when set. */
  onComment?: (range: LineRange) => void
  /** Lines to tint, e.g. the range of the note under the pointer. */
  highlight?: LineRange | null
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

/** What the rows need to select lines with the mouse. */
interface Gutter {
  /** A click on the code: comment on the line, or extend the selection with Shift. */
  click: (event: MouseEvent, side: DiffSide, line: number) => void
  /** A press on a line number or the "+". */
  press: (event: MouseEvent, side: DiffSide, line: number, fromPlus: boolean) => void
  /** The pointer moved onto a row, for drags. */
  enter: (side: DiffSide, line: number | null) => void
  selection: LineRange | null
}

interface RowsProps {
  lines: DiffLine[]
  tokens: SideTokens
  words?: WordDiffer
  moved?: MovedLines
  annotations?: LineAnnotations
  focus: Cursor | null
  gutter: Gutter | null
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

const numberOf = (line: DiffLine | null, side: DiffSide) => (line ? lineOn(line, side) : null)

function clickHandler(gutter: Gutter | null, side: DiffSide, line: DiffLine | null) {
  const number = numberOf(line, side)
  if (!gutter || number === null) return undefined
  return (event: MouseEvent) => gutter.click(event, side, number)
}

function pressHandler(gutter: Gutter | null, side: DiffSide, line: DiffLine | null, fromPlus = false) {
  const number = numberOf(line, side)
  if (!gutter || number === null) return undefined
  return (event: MouseEvent) => gutter.press(event, side, number, fromPlus)
}

const covers = (range: LineRange | null | undefined, line: DiffLine | null, side = range?.side) =>
  !!range && !!side && inRange(range, side, numberOf(line, side))

/** Class names for a line's place in the selection and the highlighted note range; a unified row takes each range's side. */
function rangeClasses(gutter: Gutter | null, highlight: LineRange | null | undefined, line: DiffLine | null, side?: DiffSide): string {
  const selection = gutter?.selection
  const selected = covers(selection, line, side)
  const end = selected && numberOf(line, selection!.side) === selection!.end
  return `${selected ? ' selected' : ''}${end ? ' selection-end' : ''}${covers(highlight, line, side) ? ' tinted' : ''}`
}

/** The gutter "+": click to comment, drag to comment on several lines. */
function AddButton({ gutter, side, line }: { gutter: Gutter | null; side: DiffSide; line: DiffLine | null }) {
  const press = pressHandler(gutter, side, line, true)
  if (!press) return null
  return (
    <button
      type="button"
      className="add-note"
      tabIndex={-1}
      aria-label="Comment on this line"
      title="Comment (drag to comment on several lines)"
      onMouseDown={press}
    >
      +
    </button>
  )
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
  const { focus, selection, tableRef, select, selectRange } = useDiffNavigation({
    blocks,
    mode,
    remaining,
    onExpandGap: (id) => expand(id, 'all'),
    onShowMore: () => setRenderLimit((n) => n + RENDER_STEP),
    actions: annotations?.actions,
  })
  const onComment = annotations?.onComment
  const drag = useLineDrag({ selection, select, selectRange, onComment })
  const gutter: Gutter | null = onComment
    ? {
        selection,
        enter: drag.enter,
        press: drag.start,
        click: (event, side, line) => {
          if (event.shiftKey) {
            window.getSelection()?.removeAllRanges()
            selectRange(side, line)
            return
          }
          const text = window.getSelection()
          if (text && !text.isCollapsed) return
          select(side, line)
          onComment(singleLine({ side, line }))
        },
      }
    : null
  const rowProps = { tokens, words, moved, annotations, focus, gutter }

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
    <table ref={tableRef} className={`diff-table ${mode}${gutter ? ' selectable' : ''}`}>
      {mode === 'split' ? (
        <colgroup>
          <col className="ln" style={{ width: LINE_NUMBER_WIDTH }} />
          <col style={{ width: MARKER_WIDTH }} />
          <col />
          <col style={{ width: LINE_NUMBER_WIDTH }} />
          <col style={{ width: MARKER_WIDTH }} />
          <col />
        </colgroup>
      ) : (
        <colgroup>
          <col style={{ width: LINE_NUMBER_WIDTH }} />
          <col style={{ width: LINE_NUMBER_WIDTH }} />
          <col style={{ width: MARKER_WIDTH }} />
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
                <UnfoldVertical size={12} aria-hidden />
                <button type="button" className="link" onClick={() => setRenderLimit((n) => n + RENDER_STEP)}>
                  show {Math.min(RENDER_STEP, remaining)} more lines
                </button>
                ·
                <button type="button" className="link" onClick={() => setRenderLimit(Number.MAX_SAFE_INTEGER)}>
                  show all {remaining} remaining lines
                </button>
              </div>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

function UnifiedRows({ lines, tokens, words, moved, annotations, focus, gutter }: RowsProps) {
  return lines.map((line, index) => {
    const oldNote = annotationFor(annotations, 'old', line)
    const newNote = annotationFor(annotations, 'new', line)
    const codeSide = line.kind === 'del' ? 'old' : 'new'
    const focused = isFocused(focus, codeSide, line)
    const range = movedRange(moved, line)
    const className = `${line.kind}${range ? ' moved' : ''}${focused ? ' kbd-focus' : ''}${rangeClasses(gutter, annotations?.highlight, line)}`
    const enter = gutter
      ? () => {
          gutter.enter('old', numberOf(line, 'old'))
          gutter.enter('new', numberOf(line, 'new'))
        }
      : undefined
    return (
      <Fragment key={index}>
        <tr className={className} {...focusProps(focused)} onMouseEnter={enter}>
          <td className="ln" onMouseDown={pressHandler(gutter, 'old', line)}>
            {line.oldNo}
          </td>
          <td className="ln" onMouseDown={pressHandler(gutter, 'new', line)}>
            {line.newNo}
          </td>
          <td className="marker">
            {MARKERS[line.kind]}
            <AddButton gutter={gutter} side={codeSide} line={line} />
          </td>
          <td className="code" onClick={clickHandler(gutter, codeSide, line)}>
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

function SplitRows({ lines, tokens, words, moved, annotations, focus, gutter }: RowsProps) {
  return toSplitRows(lines).map(({ left, right }, index) => {
    const oldNote = annotationFor(annotations, 'old', left)
    const newNote = annotationFor(annotations, 'new', right)
    const focusedOld = isFocused(focus, 'old', left)
    const focusedNew = isFocused(focus, 'new', right)
    const cells = { tokens, words, moved, annotations, gutter }
    const enter = gutter
      ? () => {
          gutter.enter('old', numberOf(left, 'old'))
          gutter.enter('new', numberOf(right, 'new'))
        }
      : undefined
    return (
      <Fragment key={index}>
        <tr className={focusedOld || focusedNew ? 'kbd-focus' : undefined} {...focusProps(focusedOld || focusedNew)} onMouseEnter={enter}>
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
  gutter: Gutter | null
  focused: boolean
  divider?: boolean
}

function SplitCells({ line, side, tokens, words, moved, annotations, gutter, focused, divider }: SplitCellsProps) {
  const range = movedRange(moved, line)
  const kind = `${line ? line.kind : 'empty'}${range ? ' moved' : ''}${rangeClasses(gutter, annotations?.highlight, line, side)}`
  const edge = `${divider ? ' split-divider' : ''}${focused ? ' kbd-side' : ''}`
  return (
    <>
      <td className={`ln ${kind}${edge}`} onMouseDown={pressHandler(gutter, side, line)}>
        {line ? (side === 'old' ? line.oldNo : line.newNo) : null}
      </td>
      <td className={`marker ${kind}${focused ? ' kbd-side' : ''}`}>
        {line ? MARKERS[line.kind] : null}
        <AddButton gutter={gutter} side={side} line={line} />
      </td>
      <td className={`code ${kind}${focused ? ' kbd-side' : ''}`} onClick={clickHandler(gutter, side, line)}>
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
  const partial = hidden > EXPAND_STEP
  return (
    <tr className="gap">
      <td colSpan={columns}>
        <div className="gap-controls">
          <UnfoldVertical size={12} aria-hidden />
          <button type="button" className="link" onClick={() => onExpand('all')} title="Expand (x)">
            {hidden} unchanged {hidden === 1 ? 'line' : 'lines'} <span className="key">x</span> expand
          </button>
          {!isFirst && partial && (
            <>
              ·
              <button type="button" className="link" onClick={() => onExpand({ top: step })} title={`Expand ${step} lines down`}>
                ↓ {step}
              </button>
            </>
          )}
          {!isLast && partial && (
            <>
              ·
              <button type="button" className="link" onClick={() => onExpand({ bottom: step })} title={`Expand ${step} lines up`}>
                ↑ {step}
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  )
}
