import type { DiffSide } from '../diff/hunks'
import { numberOn, rowIndexOf, type Cursor, type NavRow } from './diffNav'

/** Lines `start` to `end` on one side of the diff; a single line when they are equal. */
export interface LineRange {
  side: DiffSide
  start: number
  end: number
}

export const singleLine = ({ side, line }: Cursor): LineRange => ({ side, start: line, end: line })

export const rangeOf = (from: Cursor, to: Cursor): LineRange => ({
  side: from.side,
  start: Math.min(from.line, to.line),
  end: Math.max(from.line, to.line),
})

export const inRange = (range: LineRange | null | undefined, side: DiffSide, line: number | null) =>
  !!range && line !== null && range.side === side && line >= range.start && line <= range.end

export const isMultiLine = (range: LineRange | null | undefined): range is LineRange => !!range && range.end > range.start

/**
 * The far end of a selection from `from` towards `to`. Like GitHub, a range is a run of visible lines on one side:
 * it may not cross a collapsed gap, so a target beyond one stops at the last line of `from`'s hunk on that side.
 * Returns null when `from` is not visible or `to` is on the other side.
 */
export function clampExtent(rows: readonly NavRow[], from: Cursor, to: Cursor): Cursor | null {
  if (to.side !== from.side) return null
  const origin = rowIndexOf(rows, from)
  if (origin < 0) return null
  const block = rows[origin]!.block
  const target = rowIndexOf(rows, to)
  if (target >= 0 && rows[target]!.block === block) return to
  const delta = to.line >= from.line ? 1 : -1
  let line = from.line
  for (let i = origin + delta; i >= 0 && i < rows.length && rows[i]!.block === block; i += delta) {
    const number = numberOn(rows[i]!, from.side)
    if (number === null) continue
    if ((delta > 0 && number > to.line) || (delta < 0 && number < to.line)) break
    line = number
  }
  return { side: from.side, line }
}

/** The row of the next line on `side` within the same hunk, for growing a selection by keyboard; null at its edge. */
export function stepExtent(rows: readonly NavRow[], index: number, side: DiffSide, delta: 1 | -1): number | null {
  const row = rows[index]
  if (!row) return null
  for (let i = index + delta; i >= 0 && i < rows.length && rows[i]!.block === row.block; i += delta) {
    if (numberOn(rows[i]!, side) !== null) return i
  }
  return null
}

/** The selection between a fixed end and the cursor, or null unless both are visible on one side of one hunk. */
export function selectionBetween(rows: readonly NavRow[], from: Cursor | undefined, cursor: Cursor | null): LineRange | null {
  if (!from || !cursor || from.side !== cursor.side) return null
  const a = rowIndexOf(rows, from)
  const b = rowIndexOf(rows, cursor)
  if (a < 0 || b < 0 || rows[a]!.block !== rows[b]!.block) return null
  return rangeOf(from, cursor)
}
