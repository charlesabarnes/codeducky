import { describe, expect, it } from 'vitest'
import { buildLines, buildSegments, visibleBlocks } from '../../src/diff/hunks'
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
} from '../../src/keys/diffNav'

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`)
const text = (lines: string[]) => lines.join('\n') + '\n'

// 30 lines; line 5 changed, line 25 removed and two lines added at the end.
const oldLines = numbered(30)
const newLines = [...oldLines]
newLines[4] = 'line 5 changed'
newLines.splice(24, 1)
newLines.push('extra 1', 'extra 2')
const lines = buildLines(text(oldLines), text(newLines))
const blocks = visibleBlocks(buildSegments(lines), new Map())

describe('buildNavRows', () => {
  it('drops collapsed lines and records blocks', () => {
    const rows = buildNavRows(blocks, 'unified')
    expect(blocks.map((block) => block.type)).toEqual(['lines', 'gap', 'lines'])
    expect(rows.length).toBe(lines.length - (blocks[1]!.type === 'gap' ? blocks[1]!.hidden : 0))
    expect(new Set(rows.map((row) => row.block))).toEqual(new Set([0, 2]))
  })

  it('pairs removed and added lines in split view', () => {
    const unified = buildNavRows(blocks, 'unified')
    const split = buildNavRows(blocks, 'split')
    expect(split.length).toBeLessThan(unified.length)
    const changed = split.find((row) => row.old?.text === 'line 5')!
    expect(changed.new?.text).toBe('line 5 changed')
    expect(changed.change).toBe(true)
  })
})

describe('cursor targets', () => {
  const unified = buildNavRows(blocks, 'unified')
  const split = buildNavRows(blocks, 'split')

  it('puts removed lines on the base side in unified view', () => {
    const removed = unified.find((row) => row.old?.kind === 'del')!
    expect(cursorOn(removed, 'unified')).toEqual({ side: 'old', line: 5 })
    const context = unified[0]!
    expect(cursorOn(context, 'unified', 'old')).toEqual({ side: 'new', line: 1 })
  })

  it('keeps the chosen side in split view and falls back when it is empty', () => {
    const changed = split.find((row) => row.old?.text === 'line 5')!
    expect(cursorOn(changed, 'split', 'old')).toEqual({ side: 'old', line: 5 })
    expect(cursorOn(changed, 'split', 'new')).toEqual({ side: 'new', line: 5 })
    const added = split.find((row) => row.old === null)!
    expect(cursorOn(added, 'split', 'old')?.side).toBe('new')
  })

  it('finds a cursor again after switching views', () => {
    const cursor = { side: 'new' as const, line: 5 }
    expect(numberOn(unified[rowIndexOf(unified, cursor)]!, 'new')).toBe(5)
    expect(numberOn(split[rowIndexOf(split, cursor)]!, 'new')).toBe(5)
    expect(rowIndexOf(unified, { side: 'new', line: 15 })).toBe(-1)
    expect(rowIndexOf(unified, null)).toBe(-1)
  })
})

describe('line and change navigation', () => {
  const rows = buildNavRows(blocks, 'unified')

  it('steps line by line, skipping collapsed gaps, and stops at the ends', () => {
    expect(stepLine(rows, -1, 1)).toBe(0)
    expect(stepLine(rows, -1, -1)).toBe(rows.length - 1)
    const lastOfFirstBlock = rows.findLastIndex((row) => row.block === 0)
    const next = stepLine(rows, lastOfFirstBlock, 1)!
    expect(rows[next]!.block).toBe(2)
    expect(stepLine(rows, rows.length - 1, 1)).toBeNull()
    expect(stepLine(rows, 0, -1)).toBeNull()
    expect(stepLine([], -1, 1)).toBeNull()
  })

  it('jumps to the start of each run of changes', () => {
    const starts: number[] = []
    for (let i = stepChange(rows, -1, 1); i !== null; i = stepChange(rows, i, 1)) starts.push(i)
    expect(starts.map((i) => rows[i]!.old?.text ?? rows[i]!.new?.text)).toEqual(['line 5', 'line 25', 'extra 1'])
    expect(firstChange(rows)).toBe(starts[0])
    expect(lastChange(rows)).toBe(starts[2])
  })

  it('goes back to the start of the current run first', () => {
    const start = firstChange(rows)!
    expect(stepChange(rows, start + 1, -1)).toBe(start)
    expect(stepChange(rows, start, -1)).toBeNull()
  })
})

describe('notes near the focus', () => {
  const rows = buildNavRows(blocks, 'unified')
  const at = (line: number) => rowIndexOf(rows, { side: 'new', line })

  it('orders keys by distance, the focused side first, within the block', () => {
    const keys = nearbyKeys(rows, at(2), 'new', 2)
    expect(keys.slice(0, 2)).toEqual(['new:2', 'old:2'])
    expect(keys).toContain('new:3')
    expect(keys.indexOf('new:3')).toBeLessThan(keys.indexOf('new:1'))
    expect(keys).not.toContain('new:5')
  })

  it('does not reach across a collapsed gap', () => {
    const lastOfFirstBlock = rows.findLastIndex((row) => row.block === 0)
    const keys = nearbyKeys(rows, lastOfFirstBlock, 'new', 50)
    expect(keys.every((key) => Number(key.split(':')[1]) < 15)).toBe(true)
  })

  it('steps between noted rows', () => {
    const noted = new Set(['new:3', 'old:25'])
    const first = stepNote(rows, -1, 1, noted)!
    expect(numberOn(rows[first]!, 'new')).toBe(3)
    const second = stepNote(rows, first, 1, noted)!
    expect(numberOn(rows[second]!, 'old')).toBe(25)
    expect(stepNote(rows, second, 1, noted)).toBeNull()
    expect(stepNote(rows, second, -1, noted)).toBe(first)
  })
})

describe('nearestGap', () => {
  const rows = buildNavRows(blocks, 'unified')
  it('picks the gap next to the focused block, or the first gap', () => {
    const gapId = blocks[1]!.type === 'gap' ? blocks[1]!.id : -1
    expect(nearestGap(blocks, rows, -1)).toBe(gapId)
    expect(nearestGap(blocks, rows, 0)).toBe(gapId)
    expect(nearestGap(blocks, rows, rows.length - 1)).toBe(gapId)
  })

  it('returns null when nothing is collapsed', () => {
    const all = visibleBlocks(buildSegments(lines), new Map([[0, { top: 1000, bottom: 0 }]]))
    expect(nearestGap(all, buildNavRows(all, 'unified'), 0)).toBeNull()
  })
})
