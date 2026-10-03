import { lineKey, lineOn, toSplitRows, type DiffLine, type DiffSide, type VisibleBlock } from '../diff/hunks'

export type NavMode = 'unified' | 'split'

/** One visible diff row, as rendered: a line in unified view, a left/right pair in split view. */
export interface NavRow {
  old: DiffLine | null
  new: DiffLine | null
  change: boolean
  /** Index of the visible block the row belongs to; gaps sit between blocks. */
  block: number
}

/** The focused line, by side and line number, so it survives view switches and expansions. */
export interface Cursor {
  side: DiffSide
  line: number
}

export const NEAR_ROWS = 8

export function buildNavRows(blocks: readonly VisibleBlock[], mode: NavMode): NavRow[] {
  const rows: NavRow[] = []
  blocks.forEach((block, index) => {
    if (block.type !== 'lines') return
    if (mode === 'unified') {
      for (const line of block.lines) {
        rows.push({
          old: line.kind === 'add' ? null : line,
          new: line.kind === 'del' ? null : line,
          change: line.kind !== 'context',
          block: index,
        })
      }
      return
    }
    for (const { left, right } of toSplitRows(block.lines)) {
      rows.push({
        old: left,
        new: right,
        change: (left !== null && left.kind !== 'context') || (right !== null && right.kind !== 'context'),
        block: index,
      })
    }
  })
  return rows
}

export function numberOn(row: NavRow, side: DiffSide): number | null {
  const line = row[side]
  return line ? lineOn(line, side) : null
}

/**
 * Where the cursor sits on a row. Unified rows have one target (a removed line is on the
 * base side, everything else on the new side); split rows keep the preferred side if it has
 * a line there.
 */
export function cursorOn(row: NavRow, mode: NavMode, preferred: DiffSide = 'new'): Cursor | null {
  const order: DiffSide[] =
    mode === 'unified' ? ['new', 'old'] : preferred === 'old' ? ['old', 'new'] : ['new', 'old']
  for (const side of order) {
    const line = numberOn(row, side)
    if (line !== null) return { side, line }
  }
  return null
}

export function rowIndexOf(rows: readonly NavRow[], cursor: Cursor | null): number {
  if (!cursor) return -1
  return rows.findIndex((row) => numberOn(row, cursor.side) === cursor.line)
}

/** The row index one line up or down, or null at the edge. Collapsed gaps are skipped. */
export function stepLine(rows: readonly NavRow[], index: number, delta: 1 | -1): number | null {
  if (rows.length === 0) return null
  if (index < 0) return delta > 0 ? 0 : rows.length - 1
  const next = index + delta
  return next >= 0 && next < rows.length ? next : null
}

const startsChange = (rows: readonly NavRow[], i: number) => {
  const row = rows[i]!
  const previous = rows[i - 1]
  return row.change && (!previous || !previous.change || previous.block !== row.block)
}

/**
 * The first row of the next (or previous) run of changed lines. Going back from inside a run
 * lands on that run's start first, like the "previous hunk" key in Gerrit and vim.
 */
export function stepChange(rows: readonly NavRow[], index: number, delta: 1 | -1): number | null {
  if (delta > 0) {
    for (let i = Math.max(index + 1, 0); i < rows.length; i++) if (startsChange(rows, i)) return i
    return null
  }
  for (let i = (index < 0 ? rows.length : index) - 1; i >= 0; i--) if (startsChange(rows, i)) return i
  return null
}

export function firstChange(rows: readonly NavRow[]): number | null {
  return stepChange(rows, -1, 1)
}

export function lastChange(rows: readonly NavRow[]): number | null {
  return stepChange(rows, -1, -1)
}

/** Line keys on a row, the cursor's side first. */
export function rowKeys(row: NavRow, first: DiffSide = 'new'): string[] {
  const sides: DiffSide[] = first === 'old' ? ['old', 'new'] : ['new', 'old']
  const keys: string[] = []
  for (const side of sides) {
    const line = numberOn(row, side)
    if (line !== null && !keys.includes(lineKey(side, line))) keys.push(lineKey(side, line))
  }
  return keys
}

/**
 * Line keys at and around the focused row, nearest first (below before above on ties),
 * within the same visible block and NEAR_ROWS rows. Used to find "the note near the focus".
 */
export function nearbyKeys(rows: readonly NavRow[], index: number, side: DiffSide, limit = NEAR_ROWS): string[] {
  const origin = rows[index]
  if (!origin) return []
  const keys = rowKeys(origin, side)
  for (let distance = 1; distance <= limit; distance++) {
    for (const i of [index + distance, index - distance]) {
      const row = rows[i]
      if (row && row.block === origin.block) keys.push(...rowKeys(row, side))
    }
  }
  return keys
}

/** The next (or previous) row that carries a note, given the keys of noted lines. */
export function stepNote(rows: readonly NavRow[], index: number, delta: 1 | -1, noted: ReadonlySet<string>): number | null {
  const has = (i: number) => rowKeys(rows[i]!).some((key) => noted.has(key))
  if (delta > 0) {
    for (let i = Math.max(index + 1, 0); i < rows.length; i++) if (has(i)) return i
    return null
  }
  for (let i = (index < 0 ? rows.length : index) - 1; i >= 0; i--) if (has(i)) return i
  return null
}

/** The id of the collapsed gap nearest the focused row (the first gap with no focus). */
export function nearestGap(blocks: readonly VisibleBlock[], rows: readonly NavRow[], index: number): number | null {
  const gapAt = (i: number) => {
    const block = blocks[i]
    return block?.type === 'gap' ? block.id : null
  }
  const row = rows[index]
  if (!row) {
    const first = blocks.find((block) => block.type === 'gap')
    return first?.type === 'gap' ? first.id : null
  }
  const above = gapAt(row.block - 1)
  const below = gapAt(row.block + 1)
  if (above === null || below === null) return above ?? below
  let start = index
  while (start > 0 && rows[start - 1]!.block === row.block) start--
  let end = index
  while (end < rows.length - 1 && rows[end + 1]!.block === row.block) end++
  return index - start <= end - index ? above : below
}
