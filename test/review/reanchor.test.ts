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
