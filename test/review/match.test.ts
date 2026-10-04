import { describe, expect, it } from 'vitest'
import { createAnchor } from '../../src/review/anchor'
import { numberLines } from '../../src/review/lines'
import { matchAnchor } from '../../src/review/match'

const file = (...lines: string[]) => numberLines(lines.join('\n') + '\n')

const original = file(
  'import { a } from "a"',
  '',
  'export function total(items) {',
  '  let sum = 0',
  '  for (const item of items) sum += item.price',
  '  return sum',
  '}',
  '',
  'export function count(items) {',
  '  return items.length',
  '}',
)

describe('createAnchor', () => {
  it('captures the line text and up to three context lines each side', () => {
    expect(createAnchor(original, 5, 'new')).toEqual({
      line: 5,
      side: 'new',
      text: '  for (const item of items) sum += item.price',
      before: ['', 'export function total(items) {', '  let sum = 0'],
      after: ['  return sum', '}', ''],
    })
  })

  it('clips context at the start and end of the file', () => {
    const anchor = createAnchor(original, 1, 'old')
    expect(anchor.before).toEqual([])
    expect(createAnchor(original, 11, 'old').after).toEqual([])
  })

  it('rejects lines that do not exist', () => {
    expect(() => createAnchor(original, 99, 'new')).toThrow()
  })
})

describe('matchAnchor', () => {
  const anchor = createAnchor(original, 5, 'new')

  it('matches exactly in place', () => {
    expect(matchAnchor(anchor, original)).toMatchObject({ line: 5, kind: 'exact', contextScore: 6 })
  })

  it('follows the line when code is inserted above it', () => {
    const edited = file('// header', '// more', ...original.map((entry) => entry.text))
    expect(matchAnchor(anchor, edited)).toMatchObject({ line: 7, kind: 'exact' })
  })

  it('prefers the duplicate whose context matches over the nearer one', () => {
    const anchorOnReturn = createAnchor(original, 10, 'new')
    const edited = file(
      'export function count(items) {',
      '  return items.length',
      '}',
      ...original.map((entry) => entry.text),
    )
    expect(anchorOnReturn.text).toBe('  return items.length')
    expect(matchAnchor(anchorOnReturn, edited)).toMatchObject({ line: 13, kind: 'exact' })
  })

  it('falls back to the nearest line with the same text when the context changed', () => {
    const lonely = createAnchor(file('a', 'b', 'target', 'c', 'd'), 3, 'new')
    const edited = file('target', 'x', 'y', 'z', 'q', 'r', 'target', 'w')
    expect(matchAnchor(lonely, edited)).toMatchObject({ line: 1, kind: 'nearest', contextScore: 0 })
  })

  it('tolerates reindentation', () => {
    const edited = file(
      'export function total(items) {',
      '    let sum = 0',
      '    for (const item of items) sum += item.price',
      '    return sum',
      '}',
    )
    expect(matchAnchor(anchor, edited)).toMatchObject({ line: 3, kind: 'nearest' })
  })

  it('returns null when the line text is gone', () => {
    const edited = original.filter((entry) => entry.line !== 5)
    expect(matchAnchor(anchor, numberLines(edited.map((entry) => entry.text).join('\n')))).toBeNull()
  })

  it('does not anchor blank lines without any matching context', () => {
    const blank = createAnchor(original, 8, 'new')
    expect(matchAnchor(blank, file('x', '', 'y'))).toBeNull()
    expect(matchAnchor(blank, original)).toMatchObject({ line: 8, kind: 'exact' })
  })

  it('works on sparse lines and ignores context across gaps', () => {
    const sparse = [
      { line: 40, text: '  let sum = 0' },
      { line: 41, text: '  for (const item of items) sum += item.price' },
      { line: 42, text: '  return sum' },
      { line: 90, text: '  for (const item of items) sum += item.price' },
    ]
    expect(matchAnchor(anchor, sparse)).toMatchObject({ index: 1, line: 41, contextScore: 2 })
  })
})

describe('ranges', () => {
  const range = createAnchor(original, 3, 'new', 7)

  it('captures every line of the range, with context around both ends', () => {
    expect(range).toEqual({
      line: 3,
      endLine: 7,
      side: 'new',
      text: 'export function total(items) {',
      rangeText: original.slice(2, 7).map((entry) => entry.text),
      before: ['import { a } from "a"', ''],
      after: ['', 'export function count(items) {', '  return items.length'],
    })
  })

  it('keeps a one-line range a plain anchor', () => {
    expect(createAnchor(original, 5, 'new', 5)).toEqual(createAnchor(original, 5, 'new'))
  })

  it('rejects ranges that are backwards or not all present', () => {
    expect(() => createAnchor(original, 5, 'new', 4)).toThrow()
    expect(() => createAnchor(original, 9, 'new', 12)).toThrow()
    const sparse = original.filter((entry) => entry.line !== 4)
    expect(() => createAnchor(sparse, 3, 'new', 5)).toThrow()
  })

  it('finds an intact range where it moved', () => {
    const edited = file('// header', '// more', ...original.map((entry) => entry.text))
    expect(matchAnchor(range, edited)).toMatchObject({ line: 5, endLine: 9, kind: 'exact' })
  })

  it('follows both ends when lines are added inside the range', () => {
    const texts = original.map((entry) => entry.text)
    const edited = file('// header', ...texts.slice(0, 4), '  if (!items) return 0', ...texts.slice(4))
    expect(matchAnchor(range, edited)).toMatchObject({ line: 4, endLine: 9, kind: 'nearest' })
  })

  it('follows both ends when a line inside the range is removed', () => {
    const texts = original.map((entry) => entry.text)
    const edited = file(...texts.slice(0, 3), ...texts.slice(4))
    expect(matchAnchor(range, edited)).toMatchObject({ line: 3, endLine: 6 })
  })

  it('is not found when an end is gone', () => {
    const texts = original.map((entry) => entry.text)
    expect(matchAnchor(range, file(...texts.slice(0, 2), ...texts.slice(3)))).toBeNull()
  })

  it('is not found across lines that are not consecutive (two hunks of a patch)', () => {
    const sparse = original.filter((entry) => entry.line !== 5)
    expect(matchAnchor(range, sparse)).toBeNull()
  })
})
