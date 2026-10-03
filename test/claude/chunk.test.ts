import { describe, expect, it } from 'vitest'
import { chunkFile, renderLines } from '../../src/claude/chunk'
import { buildLines } from '../../src/diff/hunks'

const numbered = (count: number, label = 'line') => Array.from({ length: count }, (_, i) => `${label} ${i + 1}`)
const text = (lines: string[]) => `${lines.join('\n')}\n`

describe('chunkFile', () => {
  it('renders markers with old and new line numbers', () => {
    expect(renderLines(buildLines('a\nb\nc\n', 'a\nB\nc\nd\n'))).toBe(
      [' 1 1 | a', '-2   | b', '+  2 | B', ' 3 3 | c', '+  4 | d'].join('\n'),
    )
  })

  it('sends a small file whole, with unchanged lines as context', () => {
    const before = numbered(20)
    const after = [...before]
    after[9] = 'changed'
    const chunks = chunkFile({ path: 'src/a.ts', status: 'modified', oldText: text(before), newText: text(after) })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ path: 'src/a.ts', status: 'modified', part: 1, parts: 1, wholeFile: true })
    expect(chunks[0]!.diff).toContain(' 1  1 | line 1')
    expect(chunks[0]!.diff).toContain('-10    | line 10')
    expect(chunks[0]!.diff).toContain('+   10 | changed')
    expect(chunks[0]!.diff).toContain(' 20 20 | line 20')
  })

  it('treats an added file as all new lines', () => {
    const [chunk] = chunkFile({ path: 'new.ts', status: 'added', oldText: null, newText: 'x\ny\n' })
    expect(chunk!.diff).toBe(['+  1 | x', '+  2 | y'].join('\n'))
  })

  it('returns nothing when no lines changed', () => {
    expect(chunkFile({ path: 'same.ts', status: 'modified', oldText: 'a\n', newText: 'a\n' })).toEqual([])
  })

  it('splits a large file into hunks with context, grouped under the line cap', () => {
    const before = numbered(3000)
    const after = [...before]
    for (const line of [100, 1000, 1010, 2500]) after[line - 1] = `edit ${line}`
    const limits = { wholeFileLines: 500, context: 5, maxLines: 30 }
    const chunks = chunkFile({ path: 'big.ts', status: 'modified', oldText: text(before), newText: text(after) }, limits)

    expect(chunks.map((chunk) => [chunk.part, chunk.parts, chunk.wholeFile])).toEqual([
      [1, 3, false],
      [2, 3, false],
      [3, 3, false],
    ])
    expect(chunks[0]!.diff.startsWith('@@ old 95-105, new 95-105 @@')).toBe(true)
    expect(chunks[1]!.diff).toContain('+     1000 | edit 1000')
    expect(chunks[1]!.diff).toContain('+     1010 | edit 1010')
    expect(chunks[1]!.diff).not.toContain('line 990')
    expect(chunks[2]!.diff).toContain('edit 2500')
    for (const chunk of chunks) expect(chunk.diff.split('\n').filter((line) => !line.startsWith('@@')).length).toBeLessThanOrEqual(30)
  })

  it('slices a single hunk that is larger than the cap', () => {
    const before = numbered(1000)
    const after = numbered(1000, 'rewritten')
    const chunks = chunkFile(
      { path: 'rewrite.ts', status: 'modified', oldText: text(before), newText: text(after) },
      { wholeFileLines: 100, context: 3, maxLines: 400 },
    )
    expect(chunks).toHaveLength(5)
    expect(chunks.every((chunk) => chunk.parts === 5)).toBe(true)
    expect(chunks.map((chunk) => chunk.diff).join('\n')).toContain('rewritten 1000')
  })
})
