import { describe, expect, it } from 'vitest'
import { buildLines, buildSegments, countChanges, lineKey, toSplitRows, visibleBlocks, limitBlocks, type DiffLine } from '../../src/diff/hunks'

const numbered = (count: number, from = 1) =>
  Array.from({ length: count }, (_, i) => `line ${i + from}`).join('\n') + '\n'

const kinds = (lines: DiffLine[]) => lines.map((line) => line.kind[0]).join('')

describe('buildLines', () => {
  it('numbers context, added and removed lines', () => {
    const lines = buildLines('a\nb\nc\n', 'a\nB\nc\nd\n')
    expect(lines).toEqual([
      { kind: 'context', text: 'a', oldNo: 1, newNo: 1 },
      { kind: 'del', text: 'b', oldNo: 2, newNo: null },
      { kind: 'add', text: 'B', oldNo: null, newNo: 2 },
      { kind: 'context', text: 'c', oldNo: 3, newNo: 3 },
      { kind: 'add', text: 'd', oldNo: null, newNo: 4 },
    ])
  })

  it('treats an empty side as a full add or delete', () => {
    expect(kinds(buildLines('', 'x\ny\n'))).toBe('aa')
    expect(kinds(buildLines('x\ny\n', ''))).toBe('dd')
  })

  it('flags a missing trailing newline', () => {
    const lines = buildLines('a\n', 'a')
    expect(lines).toEqual([
      { kind: 'del', text: 'a', oldNo: 1, newNo: null },
      { kind: 'add', text: 'a', oldNo: null, newNo: 1, noNewline: true },
    ])
  })

  it('strips carriage returns from CRLF text', () => {
    expect(buildLines('a\r\n', 'a\r\nb\r\n').map((line) => line.text)).toEqual(['a', 'b'])
  })
})

describe('countChanges', () => {
  it('counts additions and deletions', () => {
    expect(countChanges('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual({ additions: 2, deletions: 1 })
    expect(countChanges('same\n', 'same\n')).toEqual({ additions: 0, deletions: 0 })
  })
})

describe('buildSegments', () => {
  it('collapses unchanged context beyond the context window into gaps', () => {
    const oldText = numbered(30)
    const newText = oldText.replace('line 15\n', 'line fifteen\n')
    const segments = buildSegments(buildLines(oldText, newText), 3)

    expect(segments.map((segment) => [segment.type, segment.lines.length])).toEqual([
      ['gap', 11],
      ['lines', 8],
      ['gap', 12],
    ])
    const [top, middle] = segments
    expect(top?.lines[0]?.oldNo).toBe(1)
    expect(middle?.lines[0]?.oldNo).toBe(12)
    expect(kinds(middle!.lines)).toBe('cccdaccc')
  })

  it('keeps short unchanged runs inline instead of creating tiny gaps', () => {
    const oldText = numbered(12)
    const newText = oldText.replace('line 2\n', 'two\n').replace('line 10\n', 'ten\n')
    const segments = buildSegments(buildLines(oldText, newText), 3)
    expect(segments).toHaveLength(1)
    expect(segments[0]?.type).toBe('lines')
  })

  it('merges overlapping context between nearby changes', () => {
    const oldText = numbered(40)
    const newText = oldText.replace('line 10\n', 'ten\n').replace('line 30\n', 'thirty\n')
    const segments = buildSegments(buildLines(oldText, newText), 3)
    expect(segments.map((segment) => segment.type)).toEqual(['gap', 'lines', 'gap', 'lines', 'gap'])
    expect(segments.filter((s) => s.type === 'gap').map((s) => (s.type === 'gap' ? s.id : -1))).toEqual([0, 1, 2])
  })

  it('collapses an unchanged file into a single gap', () => {
    const text = numbered(10)
    const segments = buildSegments(buildLines(text, text))
    expect(segments).toEqual([{ type: 'gap', id: 0, lines: expect.any(Array) }])
  })

  it('returns nothing for two empty files', () => {
    expect(buildSegments(buildLines('', ''))).toEqual([])
  })
})

describe('toSplitRows', () => {
  it('pairs removed and added lines side by side', () => {
    const rows = toSplitRows(buildLines('a\nb\nc\nd\n', 'a\nB\nC\nX\nY\nd\n'))
    expect(rows.map((row) => [row.left?.text ?? null, row.right?.text ?? null])).toEqual([
      ['a', 'a'],
      ['b', 'B'],
      ['c', 'C'],
      [null, 'X'],
      [null, 'Y'],
      ['d', 'd'],
    ])
  })

  it('leaves the right side empty for pure deletions', () => {
    const rows = toSplitRows(buildLines('a\nb\n', 'a\n'))
    expect(rows[1]).toEqual({ left: expect.objectContaining({ text: 'b', kind: 'del' }), right: null })
  })
})

describe('visibleBlocks', () => {
  const oldText = numbered(30)
  const segments = buildSegments(buildLines(oldText, oldText.replace('line 15\n', 'fifteen\n')), 3)

  it('shows gaps collapsed by default', () => {
    const blocks = visibleBlocks(segments, new Map())
    expect(blocks.map((b) => (b.type === 'gap' ? `gap:${b.hidden}` : `lines:${b.lines.length}`))).toEqual([
      'gap:11',
      'lines:8',
      'gap:12',
    ])
  })

  it('reveals lines from either edge and merges them into neighbouring lines', () => {
    const blocks = visibleBlocks(segments, new Map([[0, { top: 0, bottom: 5 }], [1, { top: 2, bottom: 0 }]]))
    expect(blocks.map((b) => (b.type === 'gap' ? `gap:${b.hidden}` : `lines:${b.lines.length}`))).toEqual([
      'gap:6',
      'lines:15',
      'gap:10',
    ])
    const middle = blocks[1]
    expect(middle?.type === 'lines' && middle.lines[0]?.oldNo).toBe(7)
  })

  it('drops a gap once fully expanded', () => {
    const blocks = visibleBlocks(segments, new Map([[0, { top: 100, bottom: 0 }], [1, { top: 0, bottom: 100 }]]))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type === 'lines' && blocks[0].lines).toHaveLength(31)
  })
})

describe('limitBlocks', () => {
  it('caps rendered lines and reports how many were held back', () => {
    const blocks = visibleBlocks(buildSegments(buildLines('', numbered(50))), new Map())
    const { blocks: limited, remaining } = limitBlocks(blocks, 20)
    expect(limited).toHaveLength(1)
    expect(limited[0]?.type === 'lines' && limited[0].lines).toHaveLength(20)
    expect(remaining).toBe(30)
  })

  it('leaves small diffs untouched', () => {
    const blocks = visibleBlocks(buildSegments(buildLines('a\n', 'b\n')), new Map())
    expect(limitBlocks(blocks, 20)).toEqual({ blocks, remaining: 0 })
  })
})

describe('pinned lines', () => {
  it('keeps pinned lines visible inside a collapsed gap', () => {
    const oldText = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    const newText = oldText.replace('line 30', 'line thirty')
    const lines = buildLines(oldText, newText)
    const plain = buildSegments(lines)
    expect(plain[0]).toMatchObject({ type: 'gap' })
    const pinned = buildSegments(lines, 3, new Set([lineKey('new', 10)]))
    expect(pinned.map((segment) => segment.type)).toEqual(['gap', 'lines', 'gap', 'lines'])
    expect(pinned[1]!.lines.map((line) => line.newNo)).toEqual([10])
  })
})
