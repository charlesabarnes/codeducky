import { describe, expect, it } from 'vitest'
import { buildPrChanges, loadPrSnapshot, movedFromPatches, prFileContents, type PrSnapshot } from '../../src/github/prDiff'
import type { PullDetail, PullFile } from '../../src/github/types'
import { base64, fakeGitHub } from './fakeGitHub'

const ref = { owner: 'acme', name: 'api' }
const HEAD = 'h'.repeat(40)
const MERGE_BASE = 'm'.repeat(40)

const pull = { number: 7, headSha: HEAD, baseSha: 'b'.repeat(40), headRef: 'feature', baseRef: 'main' } as PullDetail

const files: PullFile[] = [
  // GitHub left the patch out (too large): the diff must come from the blobs.
  { path: 'src/big.ts', previousPath: null, status: 'modified', patch: null, sha: 'new-big', additions: 400, deletions: 380 },
  { path: 'src/totals.ts', previousPath: 'src/sum.ts', status: 'renamed', patch: '@@ -1,2 +1,2 @@\n-a\n+b\n c', sha: 'new-totals', additions: 1, deletions: 1 },
  { path: 'logo.png', previousPath: null, status: 'modified', patch: null, sha: 'new-png', additions: 0, deletions: 0 },
  { path: 'src/added.ts', previousPath: null, status: 'added', patch: '@@ -0,0 +1 @@\n+x', sha: 'new-added', additions: 1, deletions: 0 },
  { path: 'src/gone.ts', previousPath: null, status: 'removed', patch: '@@ -1 +0,0 @@\n-y', sha: 'old-gone', additions: 0, deletions: 1 },
  { path: 'huge.json', previousPath: null, status: 'added', patch: null, sha: 'new-huge', additions: 90000, deletions: 0 },
]

const BLOBS: Record<string, { oid: string; byteSize: number; isBinary: boolean }> = {
  [`${MERGE_BASE}:src/big.ts`]: { oid: 'old-big', byteSize: 9000, isBinary: false },
  [`${HEAD}:src/big.ts`]: { oid: 'new-big', byteSize: 9100, isBinary: false },
  [`${MERGE_BASE}:src/sum.ts`]: { oid: 'old-sum', byteSize: 20, isBinary: false },
  [`${HEAD}:src/totals.ts`]: { oid: 'new-totals', byteSize: 22, isBinary: false },
  [`${MERGE_BASE}:logo.png`]: { oid: 'old-png', byteSize: 4000, isBinary: true },
  [`${HEAD}:logo.png`]: { oid: 'new-png', byteSize: 4100, isBinary: true },
  [`${HEAD}:src/added.ts`]: { oid: 'new-added', byteSize: 2, isBinary: false },
  [`${MERGE_BASE}:src/gone.ts`]: { oid: 'old-gone', byteSize: 2, isBinary: false },
  [`${HEAD}:huge.json`]: { oid: 'new-huge', byteSize: 5 * 1024 * 1024, isBinary: false },
}

function blobServer() {
  return fakeGitHub(({ method, path, body }) => {
    if (method === 'POST' && path === '/graphql') {
      const variables = body!.variables as Record<string, string>
      const repository: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(variables)) {
        if (/^e\d+$/.test(key)) repository[`b${key.slice(1)}`] = BLOBS[value] ?? null
      }
      return { body: { data: { repository } } }
    }
    return undefined
  })
}

const snapshot: PrSnapshot = { ref, pull, mergeBaseSha: MERGE_BASE, files }

describe('pull request diff', () => {
  it('loads the PR, its merge base and files', async () => {
    const { gh, calls } = fakeGitHub(({ path }) => {
      if (path === '/repos/acme/api/pulls/7')
        return { body: { number: 7, title: 'T', html_url: 'u', state: 'open', user: { login: 'octo' }, head: { sha: HEAD, ref: 'feature' }, base: { sha: 'b'.repeat(40), ref: 'main' }, created_at: '', updated_at: '' } }
      if (path.startsWith('/repos/acme/api/compare/')) return { body: { status: 'ahead', ahead_by: 1, behind_by: 0, merge_base_commit: { sha: MERGE_BASE } } }
      if (path === '/repos/acme/api/pulls/7/files') return { body: [{ filename: 'a.ts', status: 'modified', sha: 'x', additions: 1, deletions: 0 }] }
      return undefined
    })
    const loaded = await loadPrSnapshot(gh, ref, 7)
    expect(loaded.mergeBaseSha).toBe(MERGE_BASE)
    expect(loaded.pull).toMatchObject({ number: 7, author: 'octo', headSha: HEAD })
    expect(loaded.files[0]).toMatchObject({ path: 'a.ts', sha: 'x', additions: 1 })
    expect(calls.find((call) => call.path.includes('/compare/'))!.path).toBe(`/repos/acme/api/compare/${'b'.repeat(40)}...${HEAD}`)
  })

  it('builds changes from blob lookups, not patches', async () => {
    const { gh, calls } = blobServer()
    const built = await buildPrChanges(gh, snapshot)
    expect(calls).toHaveLength(1)
    const byPath = new Map(built.changes.map((change) => [change.path, change]))
    expect(byPath.get('src/big.ts')).toEqual({ path: 'src/big.ts', status: 'modified', oldOid: 'old-big', newOid: 'new-big' })
    expect(byPath.get('src/totals.ts')).toEqual({ path: 'src/totals.ts', status: 'modified', oldOid: 'old-sum', newOid: 'new-totals', oldPath: 'src/sum.ts' })
    expect(byPath.get('src/added.ts')).toMatchObject({ status: 'added', oldOid: null, newOid: 'new-added' })
    expect(byPath.get('src/gone.ts')).toMatchObject({ status: 'deleted', oldOid: 'old-gone', newOid: null })
    expect(built.stats['src/big.ts']).toEqual({ additions: 400, deletions: 380 })
    expect(built.stats['logo.png']).toEqual({ binary: true })
    expect(built.stats['huge.json']).toEqual({ tooLarge: true })
    expect(built.changes.map((change) => change.path)).toEqual([...built.changes.map((change) => change.path)].sort())
  })

  it('reads contents from blobs on demand and never downloads binary or oversized ones', async () => {
    const { gh } = blobServer()
    const built = await buildPrChanges(gh, snapshot)
    const loaded: string[] = []
    const load = async (oid: string) => {
      loaded.push(oid)
      return new TextEncoder().encode(oid === 'old-big' ? 'one\ntwo\n' : 'one\nthree\n')
    }
    const change = (path: string) => built.changes.find((c) => c.path === path)!

    const big = await prFileContents(change('src/big.ts'), built.metas, load)
    expect(big.old).toMatchObject({ kind: 'text', text: 'one\ntwo\n' })
    expect(big.new).toMatchObject({ kind: 'text', text: 'one\nthree\n' })

    const png = await prFileContents(change('logo.png'), built.metas, load)
    expect(png.old).toEqual({ kind: 'binary', size: 4000 })
    expect(png.new).toEqual({ kind: 'binary', size: 4100 })

    const huge = await prFileContents(change('huge.json'), built.metas, load)
    expect(huge.old).toBeNull()
    expect(huge.new).toEqual({ kind: 'too-large', size: 5 * 1024 * 1024 })
    expect(loaded.sort()).toEqual(['new-big', 'old-big'])

    // "Load diff anyway" raises the limit and fetches it.
    const forced = await prFileContents(change('huge.json'), built.metas, load, 50 * 1024 * 1024)
    expect(forced.new?.kind).toBe('text')
  })

  it('sniffs binary content that the metadata did not flag', async () => {
    const { gh } = blobServer()
    const built = await buildPrChanges(gh, snapshot)
    const contents = await prFileContents(built.changes.find((c) => c.path === 'src/added.ts')!, built.metas, async () => new Uint8Array([0, 1, 2]))
    expect(contents.new).toEqual({ kind: 'binary', size: 3 })
  })

  it('fetches a real blob through the client', async () => {
    const { gh } = fakeGitHub(({ path }) => (path === '/repos/acme/api/git/blobs/abc' ? { body: { content: base64('hello\n'), encoding: 'base64' } } : undefined))
    expect(new TextDecoder().decode(await gh.blob(ref, 'abc'))).toBe('hello\n')
  })

  it('splits lookups into batches of 100', async () => {
    const many = Array.from({ length: 150 }, (_, i): PullFile => ({ path: `f${i}.ts`, previousPath: null, status: 'added', patch: null, sha: `s${i}` }))
    const { gh, calls } = fakeGitHub(({ body }) => {
      const variables = body!.variables as Record<string, string>
      const repository: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(variables)) {
        if (/^e\d+$/.test(key)) repository[`b${key.slice(1)}`] = { oid: `oid-${value.split(':')[1]}`, byteSize: 1, isBinary: false }
      }
      return { body: { data: { repository } } }
    })
    const built = await buildPrChanges(gh, { ...snapshot, files: many })
    expect(calls).toHaveLength(2)
    expect(built.changes).toHaveLength(150)
    expect(built.changes.find((c) => c.path === 'f0.ts')!.newOid).toBe('oid-f0.ts')
  })

  it('finds moved blocks in the patches it has', () => {
    const block = ['export function total(items) {', '  return items.reduce((sum, item) => sum + item.cents, 0)', '}']
    const moved = movedFromPatches([
      { path: 'a.ts', previousPath: null, status: 'modified', patch: `@@ -1,4 +1,1 @@\n keep\n${block.map((l) => `-${l}`).join('\n')}` },
      { path: 'b.ts', previousPath: null, status: 'modified', patch: `@@ -1,1 +1,4 @@\n other\n${block.map((l) => `+${l}`).join('\n')}` },
      { path: 'c.bin', previousPath: null, status: 'modified', patch: null },
    ])
    expect(moved['a.ts']?.[0]).toMatchObject({ side: 'old', start: 2, end: 4, other: { path: 'b.ts', side: 'new', line: 2 } })
    expect(moved['b.ts']?.[0]).toMatchObject({ side: 'new', start: 2, end: 4 })
  })
})
