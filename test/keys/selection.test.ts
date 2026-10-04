import { describe, expect, it } from 'vitest'
import { buildLines, buildSegments, visibleBlocks } from '../../src/diff/hunks'
import { buildNavRows, numberOn, rowIndexOf } from '../../src/keys/diffNav'
import { clampExtent, inRange, isMultiLine, rangeOf, selectionBetween, singleLine, stepExtent } from '../../src/keys/selection'

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`)
const text = (lines: string[]) => lines.join('\n') + '\n'

// 30 lines; line 5 changed, line 25 removed and two lines added at the end: two hunks with a gap between.
const oldLines = numbered(30)
const newLines = [...oldLines]
newLines[4] = 'line 5 changed'
newLines.splice(24, 1)
newLines.push('extra 1', 'extra 2')
const lines = buildLines(text(oldLines), text(newLines))
const blocks = visibleBlocks(buildSegments(lines), new Map())
const unified = buildNavRows(blocks, 'unified')
const split = buildNavRows(blocks, 'split')

const newNumbers = (block: number) =>
  unified.filter((row) => row.block === block).flatMap((row) => (numberOn(row, 'new') === null ? [] : [numberOn(row, 'new')!]))

describe('clampExtent', () => {
  it('extends freely within a hunk', () => {
    expect(clampExtent(unified, { side: 'new', line: 2 }, { side: 'new', line: 7 })).toEqual({ side: 'new', line: 7 })
    expect(clampExtent(split, { side: 'old', line: 7 }, { side: 'old', line: 3 })).toEqual({ side: 'old', line: 3 })
  })

  it('stops at the edge of the hunk instead of crossing a collapsed gap', () => {
    const first = newNumbers(0)
    const last = newNumbers(2)
    expect(clampExtent(unified, { side: 'new', line: 3 }, { side: 'new', line: 25 })).toEqual({ side: 'new', line: Math.max(...first) })
    expect(clampExtent(split, { side: 'new', line: 28 }, { side: 'new', line: 2 })).toEqual({ side: 'new', line: Math.min(...last) })
  })

  it('stops short of a target hidden inside a gap', () => {
    expect(clampExtent(unified, { side: 'new', line: 4 }, { side: 'new', line: 15 })).toEqual({ side: 'new', line: Math.max(...newNumbers(0)) })
  })

  it('crosses what used to be a gap once it is expanded', () => {
    const expanded = buildNavRows(visibleBlocks(buildSegments(lines), new Map([[0, { top: Number.MAX_SAFE_INTEGER, bottom: 0 }]])), 'unified')
    expect(clampExtent(expanded, { side: 'new', line: 3 }, { side: 'new', line: 25 })).toEqual({ side: 'new', line: 25 })
  })

  it('refuses the other side and invisible starting points', () => {
    expect(clampExtent(unified, { side: 'new', line: 3 }, { side: 'old', line: 6 })).toBeNull()
    expect(clampExtent(unified, { side: 'new', line: 15 }, { side: 'new', line: 16 })).toBeNull()
  })
})

describe('stepExtent', () => {
  it('skips lines of the other side', () => {
    const at = rowIndexOf(unified, { side: 'new', line: 4 })
    const next = stepExtent(unified, at, 'new', 1)!
    expect(unified[at + 1]!.new).toBeNull()
    expect(numberOn(unified[next]!, 'new')).toBe(5)
  })

  it('stops at the edge of the hunk', () => {
    const lastOfFirst = rowIndexOf(unified, { side: 'new', line: Math.max(...newNumbers(0)) })
    expect(stepExtent(unified, lastOfFirst, 'new', 1)).toBeNull()
    expect(stepExtent(unified, 0, 'new', -1)).toBeNull()
    expect(stepExtent(unified, -1, 'new', 1)).toBeNull()
  })
})

describe('selectionBetween', () => {
  it('is the range between the fixed end and the cursor, in either order', () => {
    expect(selectionBetween(unified, { side: 'new', line: 7 }, { side: 'new', line: 3 })).toEqual({ side: 'new', start: 3, end: 7 })
  })

  it('is null without a fixed end, across sides or across hunks', () => {
    expect(selectionBetween(unified, undefined, { side: 'new', line: 3 })).toBeNull()
    expect(selectionBetween(unified, { side: 'old', line: 3 }, { side: 'new', line: 4 })).toBeNull()
    expect(selectionBetween(unified, { side: 'new', line: 3 }, { side: 'new', line: 28 })).toBeNull()
  })
})

describe('ranges', () => {
  it('builds, tests and sizes ranges', () => {
    const range = rangeOf({ side: 'old', line: 9 }, { side: 'old', line: 4 })
    expect(range).toEqual({ side: 'old', start: 4, end: 9 })
    expect(inRange(range, 'old', 4)).toBe(true)
    expect(inRange(range, 'old', 10)).toBe(false)
    expect(inRange(range, 'new', 5)).toBe(false)
    expect(inRange(range, 'old', null)).toBe(false)
    expect(isMultiLine(range)).toBe(true)
    expect(isMultiLine(singleLine({ side: 'new', line: 3 }))).toBe(false)
  })
})
