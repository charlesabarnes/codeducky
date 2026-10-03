import { Fragment, useMemo, useState } from 'react'
import { CodeText } from './CodeText'
import {
  buildSegments,
  limitBlocks,
  toSplitRows,
  visibleBlocks,
  type DiffLine,
  type GapExpansion,
} from './hunks'
import type { SideTokens } from './useHighlight'

export type ViewMode = 'unified' | 'split'

const EXPAND_STEP = 20
const RENDER_STEP = 2000
const MARKERS = { add: '+', del: '-', context: ' ' } as const

interface DiffTableProps {
  lines: DiffLine[]
  mode: ViewMode
  tokens: SideTokens
}

export function DiffTable({ lines, mode, tokens }: DiffTableProps) {
  const segments = useMemo(() => buildSegments(lines), [lines])
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
    <table className="diff-table">
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
                <SplitRows lines={block.lines} tokens={tokens} />
              ) : (
                <UnifiedRows lines={block.lines} tokens={tokens} />
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

function UnifiedRows({ lines, tokens }: { lines: DiffLine[]; tokens: SideTokens }) {
  return lines.map((line, index) => (
    <tr key={index} className={line.kind}>
      <td className="ln">{line.oldNo}</td>
      <td className="ln">{line.newNo}</td>
      <td className="marker">{MARKERS[line.kind]}</td>
      <td className="code">
        <CodeText line={line} tokens={tokens} />
      </td>
    </tr>
  ))
}

function SplitRows({ lines, tokens }: { lines: DiffLine[]; tokens: SideTokens }) {
  return toSplitRows(lines).map(({ left, right }, index) => (
    <tr key={index}>
      <SplitCells line={left} side="old" tokens={tokens} />
      <SplitCells line={right} side="new" tokens={tokens} divider />
    </tr>
  ))
}

interface SplitCellsProps {
  line: DiffLine | null
  side: 'old' | 'new'
  tokens: SideTokens
  divider?: boolean
}

function SplitCells({ line, side, tokens, divider }: SplitCellsProps) {
  const kind = line ? line.kind : 'empty'
  const edge = divider ? ' split-divider' : ''
  return (
    <>
      <td className={`ln ${kind}${edge}`}>{line ? (side === 'old' ? line.oldNo : line.newNo) : null}</td>
      <td className={`marker ${kind}`}>{line ? MARKERS[line.kind] : null}</td>
      <td className={`code ${kind}`}>{line && <CodeText line={line} tokens={tokens} />}</td>
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
