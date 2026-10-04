import { useRef, type MouseEvent } from 'react'
import type { Cursor } from '../keys/diffNav'
import { inRange, isMultiLine, singleLine, type LineRange } from '../keys/selection'
import type { DiffSide } from './hunks'

interface Drag {
  side: DiffSide
  origin: number
  /** Started on the gutter "+": releasing opens the note editor on the range. */
  fromPlus: boolean
  range: LineRange
}

interface Options {
  selection: LineRange | null
  select: (side: DiffSide, line: number) => void
  selectRange: (side: DiffSide, line: number, from?: Cursor) => LineRange
  onComment?: (range: LineRange) => void
}

/**
 * Mouse selection in the gutter: press on a line number or the "+" and drag over other lines on the same side,
 * or shift-click a line number to extend. Releasing a drag that began on "+" comments on the range;
 * a click on "+" inside a multi-line selection comments on that selection.
 */
export function useLineDrag({ selection, select, selectRange, onComment }: Options) {
  const drag = useRef<Drag | null>(null)

  const start = (event: MouseEvent, side: DiffSide, line: number, fromPlus: boolean) => {
    if (event.button !== 0) return
    event.preventDefault()
    if (event.shiftKey && !fromPlus) {
      selectRange(side, line)
      return
    }
    const kept = fromPlus && isMultiLine(selection) && inRange(selection, side, line) ? selection : null
    if (!kept) select(side, line)
    drag.current = { side, origin: line, fromPlus, range: kept ?? singleLine({ side, line }) }
    const finish = () => {
      window.removeEventListener('mouseup', finish)
      const done = drag.current
      drag.current = null
      if (!done?.fromPlus || !onComment) return
      onComment(done.range)
      select(done.range.side, done.range.end)
    }
    window.addEventListener('mouseup', finish)
  }

  const enter = (side: DiffSide, line: number | null) => {
    const current = drag.current
    if (!current || line === null || side !== current.side) return
    if (line === current.origin && current.range.start === current.range.end) return
    current.range = selectRange(side, line, { side, line: current.origin })
  }

  return { start, enter }
}
