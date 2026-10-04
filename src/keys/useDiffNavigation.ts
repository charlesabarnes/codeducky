import { useEffect, useMemo, useRef, useState } from 'react'
import type { DiffSide, VisibleBlock } from '../diff/hunks'
import { useKeys, useShortcuts } from './context'
import {
  buildNavRows,
  cursorOn,
  firstChange,
  lastChange,
  nearbyKeys,
  nearestGap,
  numberOn,
  rowIndexOf,
  stepChange,
  stepLine,
  stepNote,
  type Cursor,
  type NavMode,
  type NavRow,
} from './diffNav'
import { useDiffNavContext, type NavRequest } from './diffNavContext'
import { parseLineKey, type LineActions, type NoteAction } from './lineActions'
import { revealElement, type ScrollMode } from './scroll'
import { isEditableTarget } from './tokens'
import { clampExtent, isMultiLine, rangeOf, selectionBetween, singleLine, stepExtent, type LineRange } from './selection'

interface Options {
  blocks: readonly VisibleBlock[]
  mode: NavMode
  /** Lines held back by the render limit; j past the end shows more. */
  remaining: number
  onExpandGap: (id: number) => void
  onShowMore: () => void
  actions?: LineActions
}

interface CursorState {
  cursor: Cursor
  at: number
  scroll: ScrollMode
  /** The fixed end of a line selection; the cursor is its moving end. */
  anchor?: Cursor
}

const KIND_LABEL = { add: 'Added', del: 'Removed', context: 'Unchanged' } as const
const NO_NOTE: Record<NoteAction, string> = {
  edit: 'No note near the focus',
  resolve: 'No open or resolved note near the focus',
  accept: 'No suggestion near the focus',
  dismiss: 'No suggestion near the focus',
}

function fromRequest(request: NavRequest | null, rows: readonly NavRow[], mode: NavMode): CursorState | null {
  if (!request) return null
  if (typeof request.target === 'object') return { cursor: request.target, at: request.at, scroll: request.scroll ?? 'none' }
  const index = request.target === 'first-change' ? firstChange(rows) : lastChange(rows)
  const cursor = index === null ? null : cursorOn(rows[index]!, mode)
  return cursor && { cursor, at: request.at, scroll: 'center' }
}

function describe(row: NavRow, cursor: Cursor, noted: ReadonlySet<string> | undefined): string {
  const line = row[cursor.side]!
  const base = cursor.side === 'old' ? ' on the base side' : ''
  const note = noted?.has(`${cursor.side}:${cursor.line}`) ? ', has notes' : ''
  return `${KIND_LABEL[line.kind]} line ${cursor.line}${base}${note}: ${line.text.trim().slice(0, 80) || 'blank'}`
}

const describeRange = ({ start, end, side }: LineRange) =>
  `Lines ${start}–${end}${side === 'old' ? ' on the base side' : ''} selected. Press c to comment on them.`

/**
 * The keyboard cursor for one diff: j/k, J/K, n/p, N/P, h/l, x, Shift+↓/↑ and the note keys.
 * Returns the focused line and the selected range for rendering, a ref for the table (to scroll the
 * ring into view), and select functions so clicks and drags move the cursor too.
 */
export function useDiffNavigation({ blocks, mode, remaining, onExpandGap, onShowMore, actions }: Options) {
  const { announce } = useKeys()
  const { request, onBoundary } = useDiffNavContext()
  const [state, setState] = useState<CursorState | null>(null)
  const rows = useMemo(() => buildNavRows(blocks, mode), [blocks, mode])
  const requested = useMemo(() => fromRequest(request, rows, mode), [request, rows, mode])
  const current = requested && (!state || requested.at > state.at) ? requested : state
  const index = rowIndexOf(rows, current?.cursor ?? null)
  const row = index >= 0 ? rows[index]! : null
  const focus = row && current ? cursorOn(row, mode, current.cursor.side) : null
  const selection = selectionBetween(rows, current?.anchor, current?.cursor ?? null)

  const tableRef = useRef<HTMLTableElement>(null)
  const revealedAt = useRef(0)
  useEffect(() => {
    if (!current || current.at === revealedAt.current) return
    revealedAt.current = current.at
    const element = tableRef.current?.querySelector<HTMLElement>('[data-kbd-focus]')
    if (element) revealElement(element, current.scroll)
  })

  const moveTo = (target: number, scroll: ScrollMode, side: DiffSide = focus?.side ?? 'new') => {
    const targetRow = rows[target]!
    const cursor = cursorOn(targetRow, mode, side)
    if (!cursor) return
    setState({ cursor, at: Date.now(), scroll })
    announce(describe(targetRow, cursor, actions?.noted))
  }

  const extendLines = (delta: 1 | -1) => {
    if (!focus || !current) return announce('Pick a line first with j or k', { visible: true })
    const from = selection ? current.anchor! : focus
    const target = stepExtent(rows, index, from.side, delta)
    if (target === null) return announce('A selection stays within one hunk', { visible: true })
    const cursor = { side: from.side, line: numberOn(rows[target]!, from.side)! }
    setState({ cursor, anchor: from, at: Date.now(), scroll: 'nearest' })
    announce(describeRange(rangeOf(from, cursor)))
  }

  const stepLines = (delta: 1 | -1) => {
    const target = stepLine(rows, index, delta)
    if (target !== null) return moveTo(target, 'nearest')
    if (delta > 0 && remaining > 0) {
      onShowMore()
      announce('Showing more lines')
    }
  }

  const stepChanges = (delta: 1 | -1, crossFiles: boolean) => {
    const target = stepChange(rows, index, delta)
    if (target !== null) return moveTo(target, 'center')
    if (crossFiles && onBoundary(delta)) return
    announce(delta > 0 ? 'No more changes' : 'No earlier changes', { visible: true })
  }

  const stepNotes = (delta: 1 | -1) => {
    const target = actions ? stepNote(rows, index, delta, actions.noted) : null
    if (target !== null) return moveTo(target, 'center')
    announce(delta > 0 ? 'No more notes in this file' : 'No earlier notes in this file', { visible: true })
  }

  const actOnNote = (action: NoteAction) => {
    if (!actions) return false
    if (!focus) return announce('Pick a line first with j or k', { visible: true })
    const result = actions.act(action, nearbyKeys(rows, index, focus.side))
    if (!result) return announce(NO_NOTE[action], { visible: true })
    const at = parseLineKey(result.key)
    if (at.side !== focus.side || at.line !== focus.line) setState({ cursor: at, at: Date.now(), scroll: 'nearest' })
    announce(result.message, { visible: true })
  }

  // Registered in unified view too, so help lists it; it declines there so arrows still scroll.
  const pickSide = (side: DiffSide) => {
    if (!row || mode !== 'split') return false
    if (numberOn(row, side) === null) {
      announce(side === 'old' ? 'No base line on this row' : 'No new line on this row', { visible: true })
      return
    }
    moveTo(index, 'none', side)
  }

  useShortcuts('diff', {
    'line.next': () => stepLines(1),
    'line.prev': () => stepLines(-1),
    'line.extendNext': () => extendLines(1),
    'line.extendPrev': () => extendLines(-1),
    'change.next': () => stepChanges(1, false),
    'change.prev': () => stepChanges(-1, false),
    'hunk.next': () => stepChanges(1, true),
    'hunk.prev': () => stepChanges(-1, true),
    'note.next': () => stepNotes(1),
    'note.prev': () => stepNotes(-1),
    'gap.expand': () => {
      const gap = nearestGap(blocks, rows, index)
      if (gap === null) return announce('Nothing collapsed here', { visible: true })
      onExpandGap(gap)
      announce('Expanded collapsed lines')
    },
    'note.comment': () => {
      if (!actions) return false
      if (!focus) return announce('Pick a line first with j or k', { visible: true })
      if (!isMultiLine(selection)) return actions.comment(singleLine(focus))
      actions.comment(selection)
      setState({ cursor: { side: selection.side, line: selection.end }, at: Date.now(), scroll: 'nearest' })
    },
    'note.edit': () => actOnNote('edit'),
    'note.resolve': () => actOnNote('resolve'),
    'note.accept': () => actOnNote('accept'),
    'note.dismiss': () => actOnNote('dismiss'),
    escape: () => {
      if (!isMultiLine(selection) || !current || isEditableTarget(document.activeElement)) return false
      setState({ cursor: current.cursor, at: Date.now(), scroll: 'none' })
      announce('Selection cleared')
    },
  })
  useShortcuts('split', { 'side.old': () => pickSide('old'), 'side.new': () => pickSide('new') })

  const select = (side: DiffSide, line: number) => setState({ cursor: { side, line }, at: Date.now(), scroll: 'none' })

  /** Selects from `from` (by default the current selection's fixed end, or the cursor) to a line, held to one hunk. */
  const selectRange = (side: DiffSide, line: number, from: Cursor | null = (selection && current?.anchor) || focus): LineRange => {
    const extent = from ? clampExtent(rows, from, { side, line }) : null
    if (!from || !extent) {
      select(side, line)
      return singleLine({ side, line })
    }
    setState({ cursor: extent, anchor: from, at: Date.now(), scroll: 'none' })
    return rangeOf(from, extent)
  }

  return { focus, selection, tableRef, select, selectRange }
}
