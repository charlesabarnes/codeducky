import { describe, expect, it } from 'vitest'
import type { Note } from '../../src/db/schema'
import { createAnchor } from '../../src/review/anchor'
import { numberLines } from '../../src/review/lines'
import { reanchor, reanchorNotes } from '../../src/review/reanchor'

const base = numberLines('one\ntwo\nthree\nfour\nfive\nsix\nseven\n')

const note = (id: number, line: number, extra: Partial<Note> = {}): Note => ({
  id: String(id),
  sessionId: 's1',
  path: 'a.txt',
  anchor: createAnchor(base, line, 'new'),
  body: 'body',
  severity: 'issue',
  status: 'open',
  source: 'me',
  createdAt: 0,
  updatedAt: 0,
  ...extra,
})

describe('reanchor', () => {
  it('moves the anchor and refreshes its context', () => {
    const moved = reanchor(note(1, 4).anchor, numberLines('zero\none\ntwo\nthree\nfour\nfive\nsix\nseven\n'))
    expect(moved).toEqual({
      anchorLost: false,
      anchor: { line: 5, side: 'new', text: 'four', before: ['one', 'two', 'three'], after: ['five', 'six', 'seven'] },
    })
  })

  it('keeps the old anchor and flags it when the text is gone', () => {
    const original = note(1, 4).anchor
    expect(reanchor(original, numberLines('one\ntwo\nthree\nfive\n'))).toEqual({ anchor: original, anchorLost: true })
  })

  it('fills in a line-only anchor (from MCP) from the file', () => {
    const lineOnly = { line: 2, side: 'new' as const, text: '', before: [], after: [] }
    expect(reanchor(lineOnly, base)).toEqual({
      anchorLost: false,
      anchor: { line: 2, side: 'new', text: 'two', before: ['one'], after: ['three', 'four', 'five'] },
    })
    expect(reanchor({ ...lineOnly, line: 99 }, base).anchorLost).toBe(true)
  })

  it('flags the anchor when the side no longer exists', () => {
    expect(reanchor(note(1, 4).anchor, null).anchorLost).toBe(true)
  })
})

describe('reanchorNotes', () => {
  it('returns moved, refreshed and recovered notes', () => {
    const notes = [note(1, 2), note(2, 4), note(3, 6, { anchorLost: true })]
    const edited = numberLines('one\ntwo\nthree\nNEW\nfour\nfive\nsix\nseven\n')
    const updates = reanchorNotes(notes, (path) => (path === 'a.txt' ? edited : null))
    expect(updates.map((update) => [update.id, update.anchor.line, update.anchorLost])).toEqual([
      ['1', 2, false],
      ['2', 5, false],
      ['3', 7, false],
    ])
    expect(updates[0]!.anchor.after).toEqual(['three', 'NEW', 'four'])
  })

  it('reports nothing when the file is unchanged', () => {
    expect(reanchorNotes([note(1, 2), note(2, 7)], () => base)).toEqual([])
  })

  it('looks lines up by path and side', () => {
    const old = { ...note(1, 3), anchor: { ...note(1, 3).anchor, side: 'old' as const } }
    const calls: string[] = []
    reanchorNotes([old], (path, side) => {
      calls.push(`${path}:${side}`)
      return base
    })
    expect(calls).toEqual(['a.txt:old'])
  })
})

describe('reanchor ranges', () => {
  const range = createAnchor(base, 3, 'new', 5)

  it('moves both ends and refreshes the range text', () => {
    const moved = reanchor(range, numberLines('zero\none\ntwo\nthree\nfour\nfive\nsix\nseven\n'))
    expect(moved).toEqual({ anchorLost: false, anchor: createAnchor(numberLines('zero\none\ntwo\nthree\nfour\nfive\nsix\nseven\n'), 4, 'new', 6) })
  })

  it('grows with lines added inside it', () => {
    const edited = numberLines('one\ntwo\nthree\nthree and a half\nfour\nfive\nsix\nseven\n')
    const { anchor, anchorLost } = reanchor(range, edited)
    expect(anchorLost).toBe(false)
    expect(anchor).toMatchObject({ line: 3, endLine: 6, rangeText: ['three', 'three and a half', 'four', 'five'] })
  })

  it('is lost, keeping its anchor, when an end is gone', () => {
    expect(reanchor(range, numberLines('one\ntwo\nfour\nfive\nsix\nseven\n'))).toEqual({ anchor: range, anchorLost: true })
  })

  it('fills in a line-only range (from MCP) from the file', () => {
    const lineOnly = { line: 2, endLine: 4, side: 'new' as const, text: '', before: [], after: [] }
    expect(reanchor(lineOnly, base)).toEqual({ anchorLost: false, anchor: createAnchor(base, 2, 'new', 4) })
    expect(reanchor({ ...lineOnly, endLine: 99 }, base).anchorLost).toBe(true)
  })

  it('reports a range whose end moved even when its start did not', () => {
    const notes = [note(1, 3, { anchor: range })]
    const edited = numberLines('one\ntwo\nthree\nNEW\nfour\nfive\nsix\nseven\n')
    expect(reanchorNotes(notes, () => edited).map((update) => [update.anchor.line, update.anchor.endLine])).toEqual([[3, 6]])
    expect(reanchorNotes(notes, () => base)).toEqual([])
  })
})
