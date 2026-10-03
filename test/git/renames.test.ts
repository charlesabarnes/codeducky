import { describe, expect, it } from 'vitest'
import { detectRenames, type RenameReader } from '../../src/git/renames'
import { fingerprint, similarity } from '../../src/git/similarity'
import type { FileChange } from '../../src/git/types'

const bytes = (text: string) => new TextEncoder().encode(text)
const lines = (count: number, tag = 'line') => Array.from({ length: count }, (_, i) => `${tag} number ${i} with some text\n`).join('')

describe('similarity', () => {
  it('is 1 for identical content and 0 for unrelated content', () => {
    const a = fingerprint(bytes(lines(20)))
    expect(similarity(a, fingerprint(bytes(lines(20))))).toBe(1)
    expect(similarity(a, fingerprint(bytes(lines(20, 'other'))))).toBe(0)
  })

  it('measures copied bytes against the larger file', () => {
    const base = lines(10)
    const score = similarity(fingerprint(bytes(base)), fingerprint(bytes(base + lines(10, 'added'))))
    expect(score).toBeGreaterThan(0.45)
    expect(score).toBeLessThan(0.55)
  })

  it('ignores CR in CRLF pairs', () => {
    const lf = lines(10)
    expect(similarity(fingerprint(bytes(lf)), fingerprint(bytes(lf.replace(/\n/g, '\r\n'))))).toBe(1)
  })

  it('short-circuits when sizes rule out the minimum', () => {
    expect(similarity(fingerprint(bytes(lines(2))), fingerprint(bytes(lines(40))), 0.5)).toBe(0)
  })
})

function reader(oldFiles: Record<string, string>, newFiles: Record<string, string>): RenameReader & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    async readOld(change) {
      reads.push(`old:${change.path}`)
      return bytes(oldFiles[change.path]!)
    },
    async readNew(change) {
      reads.push(`new:${change.path}`)
      return bytes(newFiles[change.path]!)
    },
  }
}

const deleted = (path: string, oid: string): FileChange => ({ path, status: 'deleted', oldOid: oid, newOid: null })
const added = (path: string, oid: string): FileChange => ({ path, status: 'added', oldOid: null, newOid: oid })
const modified = (path: string): FileChange => ({ path, status: 'modified', oldOid: 'm1', newOid: 'm2' })

describe('detectRenames', () => {
  it('pairs identical blobs without reading content', async () => {
    const io = reader({}, {})
    const { changes } = await detectRenames([deleted('src/old.ts', 'aaa'), added('src/new.ts', 'aaa'), modified('x.ts')], io)
    expect(changes).toEqual([
      { path: 'src/new.ts', status: 'modified', oldOid: 'aaa', newOid: 'aaa', oldPath: 'src/old.ts', similarity: 100 },
      modified('x.ts'),
    ])
    expect(io.reads).toEqual([])
  })

  it('prefers the same file name among identical candidates', async () => {
    const { changes } = await detectRenames(
      [deleted('a/index.ts', 'same'), deleted('b/util.ts', 'same'), added('c/util.ts', 'same')],
      reader({}, {}),
    )
    expect(changes.find((change) => change.path === 'c/util.ts')?.oldPath).toBe('b/util.ts')
    expect(changes.some((change) => change.path === 'a/index.ts' && change.status === 'deleted')).toBe(true)
  })

  it('pairs similar files at 50% or more and keeps the rest as added/deleted', async () => {
    const body = lines(30)
    const io = reader(
      { 'lib/math.ts': body, 'lib/gone.ts': lines(30, 'gone') },
      { 'src/math.ts': body.replace('line number 3 ', 'LINE NUMBER 3 '), 'src/fresh.ts': lines(30, 'fresh') },
    )
    const { changes, limited } = await detectRenames(
      [deleted('lib/gone.ts', 'g'), deleted('lib/math.ts', 'm'), added('src/fresh.ts', 'f'), added('src/math.ts', 'n')],
      io,
    )
    expect(limited).toBe(false)
    const rename = changes.find((change) => change.path === 'src/math.ts')!
    expect(rename).toMatchObject({ status: 'modified', oldPath: 'lib/math.ts', oldOid: 'm', newOid: 'n' })
    expect(rename.similarity).toBeGreaterThanOrEqual(90)
    expect(changes.map((change) => `${change.status}:${change.path}`)).toEqual(['deleted:lib/gone.ts', 'added:src/fresh.ts', 'modified:src/math.ts'])
  })

  it('assigns each file once, best score first', async () => {
    const body = lines(30)
    const io = reader({ 'old.ts': body }, { 'copy1.ts': body + lines(5, 'x'), 'copy2.ts': body + lines(1, 'y') })
    const { changes } = await detectRenames([deleted('old.ts', 'o'), added('copy1.ts', 'c1'), added('copy2.ts', 'c2')], io)
    expect(changes.find((change) => change.oldPath)?.path).toBe('copy2.ts')
    expect(changes.find((change) => change.path === 'copy1.ts')?.status).toBe('added')
  })

  it('only pairs identical files when the change set is too large', async () => {
    const io = reader({ 'a.ts': lines(10) }, { 'b.ts': lines(10) + 'x\n' })
    const result = await detectRenames([deleted('a.ts', '1'), added('b.ts', '2')], io, { maxPairs: 0 })
    expect(result.limited).toBe(true)
    expect(result.changes.every((change) => !change.oldPath)).toBe(true)
    expect(io.reads).toEqual([])
  })

  it('skips binary and empty files', async () => {
    const io = reader({ 'a.bin': 'x\u0000y', 'e.txt': '' }, { 'b.bin': 'x\u0000y!', 'f.txt': '' })
    const { changes } = await detectRenames([deleted('a.bin', '1'), deleted('e.txt', '2'), added('b.bin', '3'), added('f.txt', '4')], io)
    expect(changes.some((change) => change.oldPath)).toBe(false)
  })
})
