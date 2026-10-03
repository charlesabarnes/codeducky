import { describe, expect, it } from 'vitest'
import { buildLines, type DiffLine } from '../../src/diff/hunks'
import { createWordDiffer, layerRanges, MAX_WORD_DIFF_CHARS, pairChangedLines, wordChanges } from '../../src/diff/wordDiff'

const marked = (text: string, ranges: { start: number; end: number }[] | null) =>
  (ranges ?? []).map(({ start, end }) => text.slice(start, end))

describe('pairChangedLines', () => {
  it('pairs the n-th removed line with the n-th added line in each run', () => {
    const lines = buildLines('a\nb\nc\nx\nd\n', 'a\nB\nC\nD2\nx\n')
    const partners = pairChangedLines(lines)
    const text = (line: DiffLine | undefined) => line?.text
    const del = (value: string) => lines.find((line) => line.kind === 'del' && line.text === value)!
    expect(text(partners.get(del('b')))).toBe('B')
    expect(text(partners.get(del('c')))).toBe('C')
    expect(partners.has(del('d'))).toBe(false)
    expect(text(partners.get(lines.find((line) => line.text === 'B')!))).toBe('b')
  })

  it('leaves unmatched extra lines unpaired', () => {
    const lines = buildLines('one\n', 'uno\ndos\n')
    const partners = pairChangedLines(lines)
    expect(partners.size).toBe(2)
    expect(partners.has(lines.find((line) => line.text === 'dos')!)).toBe(false)
  })
})

describe('wordChanges', () => {
  it('marks only the changed words on each side', () => {
    const oldText = 'const total = subtotal + tax'
    const newText = 'const total = subtotal + tax - discount'
    const changes = wordChanges(oldText, newText)!
    expect(marked(oldText, changes.old)).toEqual([])
    expect(marked(newText, changes.new)).toEqual([' - discount'])
  })

  it('marks a replaced identifier on both sides', () => {
    const changes = wordChanges('retry(attempt, delay)', 'retry(attempt, backoff)')!
    expect(marked('retry(attempt, delay)', changes.old)).toEqual(['delay'])
    expect(marked('retry(attempt, backoff)', changes.new)).toEqual(['backoff'])
  })

  it('skips very long lines', () => {
    const long = 'x '.repeat(MAX_WORD_DIFF_CHARS)
    expect(wordChanges(long, `${long}y`)).toBeNull()
  })

  it('skips lines that share almost nothing', () => {
    expect(wordChanges('import { a } from "b"', 'return computeEverything()')).toBeNull()
  })

  it('bridges whitespace between changed words', () => {
    const changes = wordChanges('foo bar baz qux', 'foo BAR BAZ qux')!
    expect(changes.new).toEqual([{ start: 4, end: 11 }])
  })
})

describe('createWordDiffer', () => {
  it('returns ranges for paired lines only, and caches them', () => {
    const lines = buildLines('let a = 1\nkeep\n', 'let a = 2\nkeep\nextra line\n')
    const differ = createWordDiffer(lines)
    const del = lines.find((line) => line.kind === 'del')!
    const add = lines.find((line) => line.text === 'let a = 2')!
    expect(marked(add.text, differ(add))).toEqual(['2'])
    expect(marked(del.text, differ(del))).toEqual(['1'])
    expect(differ(lines.find((line) => line.text === 'extra line')!)).toBeNull()
    expect(differ(add)).toBe(differ(add))
  })
})

describe('layerRanges', () => {
  it('splits tokens at range edges and keeps their colours', () => {
    const tokens = [
      { content: 'const ', color: '#a' },
      { content: 'total', color: '#b' },
      { content: ' = 2', color: '#c' },
    ]
    const pieces = layerRanges(tokens, 'const total = 2', [{ start: 8, end: 11 }, { start: 14, end: 15 }])
    expect(pieces).toEqual([
      { text: 'const ', color: '#a', changed: false },
      { text: 'to', color: '#b', changed: false },
      { text: 'tal', color: '#b', changed: true },
      { text: ' = ', color: '#c', changed: false },
      { text: '2', color: '#c', changed: true },
    ])
    expect(pieces.map((piece) => piece.text).join('')).toBe('const total = 2')
  })

  it('works on plain text without tokens', () => {
    expect(layerRanges(null, 'abc', [{ start: 1, end: 2 }])).toEqual([
      { text: 'a', color: undefined, changed: false },
      { text: 'b', color: undefined, changed: true },
      { text: 'c', color: undefined, changed: false },
    ])
  })
})

describe('pairChangedLines with skipped lines', () => {
  it('pairs around lines that moved', () => {
    const lines = buildLines('keep\nmoved away\nold value 1\n', 'keep\nnew value 2\n')
    const moved = lines.find((line) => line.text === 'moved away')!
    const partners = pairChangedLines(lines, (line) => line === moved)
    expect(partners.get(lines.find((line) => line.text === 'old value 1')!)?.text).toBe('new value 2')
    expect(partners.has(moved)).toBe(false)
  })
})

describe('very long runs', () => {
  it('pairs a 200k-line run without overflowing the stack', () => {
    const lines = Array.from({ length: 200_000 }, (_, i) => ({ kind: 'add' as const, text: `x${i}`, oldNo: null, newNo: i + 1 }))
    expect(pairChangedLines(lines, () => false).size).toBe(0)
  })
})
