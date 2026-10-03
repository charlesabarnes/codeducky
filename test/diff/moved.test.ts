import { describe, expect, it } from 'vitest'
import { buildLines } from '../../src/diff/hunks'
import { detectMovedBlocks, movedAt } from '../../src/diff/moved'

const block = ['export function total(items) {', '  const sum = items.reduce((a, b) => a + b, 0)', '  return Math.round(sum * 100) / 100', '}']
const text = (lines: string[]) => lines.map((line) => `${line}\n`).join('')

describe('detectMovedBlocks', () => {
  it('finds a block moved within a file', () => {
    const rest = ['a', 'b', 'c', 'd', 'e', 'f'].map((name, i) => `export const ${name} = ${i}`)
    const before = text(['// header', ...block, '', ...rest])
    const after = text(['// header', ...rest, '', ...block])
    const moved = detectMovedBlocks([{ path: 'src/math.ts', lines: buildLines(before, after) }])
    const ranges = moved['src/math.ts']!
    const removed = ranges.find((range) => range.side === 'old')!
    const added = ranges.find((range) => range.side === 'new')!
    expect(removed).toMatchObject({ start: 2, end: 5, other: { path: 'src/math.ts', side: 'new', line: 9 } })
    expect(added).toMatchObject({ start: 9, end: 12, other: { path: 'src/math.ts', side: 'old', line: 2 } })
    expect(movedAt(ranges, 'old', 4)).toBe(removed)
    expect(movedAt(ranges, 'new', 8)).toBeNull()
  })

  it('finds a block moved to another file', () => {
    const moved = detectMovedBlocks([
      { path: 'src/a.ts', lines: buildLines(text(['import x', ...block, 'tail']), text(['import x', 'tail'])) },
      { path: 'src/b.ts', lines: buildLines(text(['head']), text(['head', ...block])) },
    ])
    expect(moved['src/a.ts']).toEqual([{ side: 'old', start: 2, end: 5, other: { path: 'src/b.ts', side: 'new', line: 2 } }])
    expect(moved['src/b.ts']).toEqual([{ side: 'new', start: 2, end: 5, other: { path: 'src/a.ts', side: 'old', line: 2 } }])
  })

  it('ignores blocks shorter than three non-blank lines', () => {
    const two = block.slice(1, 3)
    const moved = detectMovedBlocks([
      { path: 'a.ts', lines: buildLines(text(['x', ...two]), text(['x'])) },
      { path: 'b.ts', lines: buildLines('', text(two)) },
    ])
    expect(moved).toEqual({})
  })

  it('ignores runs of punctuation such as closing braces', () => {
    const braces = ['    }', '  }', '}']
    const moved = detectMovedBlocks([
      { path: 'a.ts', lines: buildLines(text(['x', ...braces]), text(['x'])) },
      { path: 'b.ts', lines: buildLines('', text(braces)) },
    ])
    expect(moved).toEqual({})
  })

  it('does not count blank lines toward the minimum', () => {
    const sparse = [block[1]!, '', block[2]!, '']
    const moved = detectMovedBlocks([
      { path: 'a.ts', lines: buildLines(text(['x', ...sparse]), text(['x'])) },
      { path: 'b.ts', lines: buildLines('', text(sparse)) },
    ])
    expect(moved).toEqual({})
  })

  it('uses each removed line once', () => {
    const moved = detectMovedBlocks([
      { path: 'a.ts', lines: buildLines(text(block), '') },
      { path: 'b.ts', lines: buildLines('', text(block)) },
      { path: 'c.ts', lines: buildLines('', text(block)) },
    ])
    expect(moved['b.ts']).toHaveLength(1)
    expect(moved['c.ts']).toBeUndefined()
  })
})
