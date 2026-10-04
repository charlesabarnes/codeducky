import { describe, expect, it } from 'vitest'
import type { Note } from '../../src/db/schema'
import { createAnchor } from '../../src/review/anchor'
import { numberLines } from '../../src/review/lines'
import { anchorForView, placeNotes } from '../../src/review/viewNotes'

const FINAL = numberLines(['import x', '', 'function a() {', '  return total * 2', '}', '', 'function b() {', '  return 1', '}', ''].join('\n'))
// The same file as of an earlier commit: a() sat lower, and a line later removed was there.
const COMMIT = numberLines(['import x', 'import y', '', 'function a() {', '  return total * 2', '}', '', 'const legacy = y()', ''].join('\n'))

const note = (id: string, extra: Partial<Note>): Note => ({
  id,
  sessionId: 's',
  path: 'a.ts',
  anchor: createAnchor(FINAL, 4, 'new'),
  body: id,
  severity: 'nit',
  status: 'open',
  source: 'me',
  createdAt: 0,
  updatedAt: 0,
  ...extra,
})

describe('notes in commit and since-last-look views', () => {
  const onFinal = note('final', {})
  const onBase = note('base', { anchor: { line: 2, side: 'old', text: 'old', before: [], after: [] } })
  const onCommit = note('commit', { anchor: createAnchor(COMMIT, 8, 'new'), commit: 'c1' })
  const onOther = note('other', { anchor: createAnchor(COMMIT, 8, 'new'), commit: 'c0' })
  const gone = note('gone', { anchor: { line: 9, side: 'new', text: 'not anywhere', before: [], after: [] } })
  const all = [onFinal, onBase, onCommit, onOther, gone]

  it('shows stored anchors in All changes, and lists commit notes apart', () => {
    const { placed, elsewhere } = placeNotes(all, FINAL, { kind: 'all' })
    expect(placed.map((n) => n.id)).toEqual(['final', 'base', 'gone'])
    expect(elsewhere.map((n) => n.id)).toEqual(['commit', 'other'])
  })

  it('keeps new-side notes in place on an interdiff and lists base-side ones apart', () => {
    const { placed, elsewhere } = placeNotes(all, FINAL, { kind: 'interdiff' })
    expect(placed.map((n) => n.id)).toEqual(['final', 'gone'])
    expect(elsewhere.map((n) => n.id)).toEqual(['base', 'commit', 'other'])
  })

  it('moves final-content notes onto a commit’s lines and shows that commit’s own notes', () => {
    const { placed, elsewhere } = placeNotes(all, COMMIT, { kind: 'commit', sha: 'c1' })
    expect(placed.map((n) => [n.id, n.anchor.line])).toEqual([
      ['final', 5],
      ['commit', 8],
    ])
    expect(elsewhere.map((n) => n.id)).toEqual(['base', 'other', 'gone'])
    // Display copies only: the stored note keeps its line.
    expect(onFinal.anchor.line).toBe(4)
  })

  it('anchors a commit-mode note on the final content while its line survives, else on the commit', () => {
    const shown = { old: null, new: COMMIT }
    const kept = anchorForView({ kind: 'commit', sha: 'c1' }, 'new', 5, shown, FINAL)
    expect(kept).toEqual({ anchor: createAnchor(FINAL, 4, 'new') })
    const stays = anchorForView({ kind: 'commit', sha: 'c1' }, 'new', 8, shown, FINAL)
    expect(stays).toEqual({ anchor: createAnchor(COMMIT, 8, 'new'), commit: 'c1' })
    // A lone `}` matches the final file but not its context: it stays on the commit.
    const brace = anchorForView({ kind: 'commit', sha: 'c1' }, 'new', 3, { old: null, new: numberLines('x\ny\n}\n') }, FINAL)
    expect(brace).toMatchObject({ commit: 'c1' })
    // The file is gone from the final diff.
    expect(anchorForView({ kind: 'commit', sha: 'c1' }, 'new', 5, shown, null)).toMatchObject({ commit: 'c1' })
  })

  it('refuses base-side lines outside All changes', () => {
    const shown = { old: FINAL, new: FINAL }
    expect(anchorForView({ kind: 'interdiff' }, 'old', 2, shown, null)).toHaveProperty('error')
    expect(anchorForView({ kind: 'all' }, 'old', 2, shown, null)).toEqual({ anchor: createAnchor(FINAL, 2, 'old') })
    expect(anchorForView({ kind: 'interdiff' }, 'new', 4, shown, null)).toEqual({ anchor: createAnchor(FINAL, 4, 'new') })
  })
})

describe('ranges in commit views', () => {
  it('moves both ends of a final-content range onto the commit’s lines', () => {
    const range = note('range', { anchor: createAnchor(FINAL, 3, 'new', 5) })
    const { placed } = placeNotes([range], COMMIT, { kind: 'commit', sha: 'c1' })
    expect(placed.map((n) => [n.anchor.line, n.anchor.endLine])).toEqual([[4, 6]])
  })

  it('anchors a range made on a commit on the final content while it survives', () => {
    const shown = { old: null, new: COMMIT }
    expect(anchorForView({ kind: 'commit', sha: 'c1' }, 'new', 4, shown, FINAL, 6)).toEqual({ anchor: createAnchor(FINAL, 3, 'new', 5) })
    expect(anchorForView({ kind: 'all' }, 'new', 3, { old: null, new: FINAL }, null, 5)).toEqual({ anchor: createAnchor(FINAL, 3, 'new', 5) })
  })
})
