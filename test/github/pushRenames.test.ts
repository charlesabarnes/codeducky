import { describe, expect, it } from 'vitest'
import type { Note } from '../../src/db/schema'
import { placeNotes } from '../../src/github/push'
import type { PullFile } from '../../src/github/types'
import { createAnchor } from '../../src/review/anchor'
import { numberLines } from '../../src/review/lines'

const oldText = 'export function total(items) {\n  return sum(items)\n}\n'
const newText = 'export function total(items) {\n  return sum(items, 0)\n}\n'
const patch = '@@ -1,3 +1,3 @@\n export function total(items) {\n-  return sum(items)\n+  return sum(items, 0)\n }'

const note = (path: string, side: 'old' | 'new', line: number): Note => ({
  id: `${path}:${side}:${line}`,
  sessionId: 's',
  path,
  anchor: createAnchor(numberLines(side === 'old' ? oldText : newText), line, side),
  body: 'Check',
  severity: 'issue',
  status: 'open',
  source: 'me',
  createdAt: 0,
  updatedAt: 0,
})

describe('placeNotes with renames', () => {
  const renamedFile: PullFile = { path: 'src/totals.ts', previousPath: 'src/sum.ts', status: 'renamed', patch }

  it('places a note left on the old name on the renamed file', () => {
    const { placed, unplaced } = placeNotes([note('src/sum.ts', 'old', 2)], [renamedFile])
    expect(unplaced).toEqual([])
    expect(placed[0]!.comment).toMatchObject({ path: 'src/totals.ts', line: 2, side: 'LEFT' })
  })

  it('places notes on the new name on both sides', () => {
    const { placed } = placeNotes([note('src/totals.ts', 'new', 2), note('src/totals.ts', 'old', 2)], [renamedFile])
    expect(placed.map((entry) => `${entry.comment.side}:${entry.comment.line}`)).toEqual(['RIGHT:2', 'LEFT:2'])
  })

  it('sends base-side notes to the deleted path when GitHub did not pair the rename', () => {
    const files: PullFile[] = [
      { path: 'src/sum.ts', previousPath: null, status: 'removed', patch: '@@ -1,3 +0,0 @@\n-export function total(items) {\n-  return sum(items)\n-}' },
      { path: 'src/totals.ts', previousPath: null, status: 'added', patch: '@@ -0,0 +1,3 @@\n+export function total(items) {\n+  return sum(items, 0)\n+}' },
    ]
    const renames = new Map([['src/totals.ts', 'src/sum.ts']])
    const { placed, unplaced } = placeNotes([note('src/totals.ts', 'old', 2), note('src/totals.ts', 'new', 2)], files, renames)
    expect(unplaced).toEqual([])
    expect(placed.map((entry) => `${entry.comment.path}:${entry.comment.side}`).sort()).toEqual(['src/sum.ts:LEFT', 'src/totals.ts:RIGHT'])
  })
})
