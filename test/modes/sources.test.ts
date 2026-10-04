import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { prCommitSource, sinceSource } from '../../src/features/modes/modeSources'
import type { DiffSource } from '../../src/features/session/source'
import type { FileChange, FileContents } from '../../src/git/types'
import { classifySince, lastLooks } from '../../src/review/lastLook'
import { base64, fakeGitHub } from '../github/fakeGitHub'

const ref = { owner: 'acme', name: 'api' }
const text = (value: string) => ({ kind: 'text' as const, text: value, size: value.length })

describe('since last look source', () => {
  const files: FileChange[] = [
    { path: 'a.ts', status: 'modified', oldOid: 'base-a', newOid: 'now-a' },
    { path: 'b.ts', status: 'modified', oldOid: 'base-b', newOid: 'now-b' },
    { path: 'c.ts', status: 'added', oldOid: null, newOid: 'now-c' },
  ]
  const CONTENT: Record<string, string> = { 'base-a': 'one\n', 'now-a': 'one\ntwo\nthree\n', 'base-b': 'x\n', 'now-b': 'x\ny\n', 'now-c': 'c\n' }
  const reads: string[] = []
  const base: DiffSource = {
    key: 'base',
    listFiles: async () => ({ files, renamesLimited: false }),
    analyze: async () => ({ stats: {}, moved: {} }),
    async contents(change): Promise<FileContents> {
      reads.push(`${change.path}:${change.oldOid ?? '-'}`)
      return {
        path: change.path,
        old: change.oldOid ? text(CONTENT[change.oldOid]!) : null,
        new: change.newOid ? text(CONTENT[change.newOid]!) : null,
      }
    },
    ciHead: async () => 'head',
    dirtyPaths: async () => new Set(),
  }
  const reviewed: Record<string, string> = { 'rev-a': 'one\ntwo\n' }
  const looks = lastLooks([
    { sessionId: 's', path: 'a.ts', contentHash: 'base-a:rev-a', viewed: false, reviewedOid: 'rev-a', reviewedAt: 1 },
    { sessionId: 's', path: 'b.ts', contentHash: 'base-b:rev-b', viewed: false, reviewedOid: 'rev-b', reviewedAt: 1 },
  ])
  const entries = classifySince(files, looks, () => true)
  const source = sinceSource(
    base,
    entries,
    async (oid) => {
      if (!reviewed[oid]) throw new Error('not here')
      return new TextEncoder().encode(reviewed[oid])
    },
    { 'c.ts': { additions: 1, deletions: 0 } },
  )

  it('diffs a changed file from the reviewed content to the current content', async () => {
    reads.length = 0
    const contents = await source.contents(entries[0]!.change)
    expect(contents.old).toEqual(text('one\ntwo\n'))
    expect(contents.new).toEqual(text('one\ntwo\nthree\n'))
    // The base side is never read for an interdiff.
    expect(reads).toEqual(['a.ts:-'])
  })

  it('falls back to the full diff with a notice when the reviewed content cannot be read', async () => {
    const contents = await source.contents(entries[1]!.change)
    expect(contents.old).toEqual(text('x\n'))
    expect(contents.notice).toMatch(/Could not read the version you reviewed/)
  })

  it('shows never-viewed files as their full diff and counts interdiff lines', async () => {
    expect((await source.contents(entries[2]!.change)).new).toEqual(text('c\n'))
    const { stats } = await source.analyze((await source.listFiles()).files)
    expect(stats).toEqual({ 'a.ts': { additions: 1, deletions: 0 }, 'c.ts': { additions: 1, deletions: 0 } })
  })
})

describe('pull request commits', () => {
  const BASE = 'p'.repeat(40)
  const C1 = '1'.repeat(40)
  const C2 = '2'.repeat(40)
  const raw = (sha: string, parents: string[], message: string) => ({
    sha,
    parents: parents.map((p) => ({ sha: p })),
    commit: { message, author: { name: 'Ada', date: '2026-10-01T12:00:00Z' } },
    author: { login: 'ada' },
  })

  it('lists the commits oldest first and marks merges', async () => {
    const { gh } = fakeGitHub(({ path }) =>
      path === '/repos/acme/api/pulls/7/commits' ? { body: [raw(C1, [BASE], 'Add retries\n\nbody'), raw(C2, [C1, BASE], 'Merge main')] } : undefined,
    )
    const commits = await gh.pullCommits(ref, 7)
    expect(commits).toEqual([
      { sha: C1, parents: [BASE], message: 'Add retries\n\nbody', author: 'Ada', date: Date.parse('2026-10-01T12:00:00Z') },
      { sha: C2, parents: [C1, BASE], message: 'Merge main', author: 'Ada', date: Date.parse('2026-10-01T12:00:00Z') },
    ])
  })

  it('builds a commit range diff from the compare files and blobs at both ends', async () => {
    const BLOBS: Record<string, { oid: string; byteSize: number; isBinary: boolean }> = {
      [`${BASE}:src/a.ts`]: { oid: 'old-a', byteSize: 4, isBinary: false },
      [`${C2}:src/a.ts`]: { oid: 'new-a', byteSize: 6, isBinary: false },
      [`${C2}:src/new.ts`]: { oid: 'new-n', byteSize: 2, isBinary: false },
    }
    const { gh, calls } = fakeGitHub(({ method, path, body }) => {
      if (path === `/repos/acme/api/compare/${BASE}...${C2}`) {
        return {
          body: {
            files: [
              { filename: 'src/a.ts', status: 'modified', sha: 'new-a', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n a\n+b' },
              { filename: 'src/new.ts', status: 'added', sha: 'new-n', additions: 1, deletions: 0 },
            ],
          },
        }
      }
      if (method === 'POST' && path === '/graphql') {
        const variables = body!.variables as Record<string, string>
        const repository: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(variables)) if (/^e\d+$/.test(key)) repository[`b${key.slice(1)}`] = BLOBS[value] ?? null
        return { body: { data: { repository } } }
      }
      const blob = /\/git\/blobs\/(.+)$/.exec(path)?.[1]
      if (blob) return { body: { encoding: 'base64', content: base64({ 'old-a': 'a\n', 'new-a': 'a\nb\n', 'new-n': 'n\n' }[blob]!) } }
      return undefined
    })
    const source = prCommitSource(gh, ref, BASE, C2)
    const { files } = await source.listFiles()
    expect(files).toEqual([
      { path: 'src/a.ts', status: 'modified', oldOid: 'old-a', newOid: 'new-a' },
      { path: 'src/new.ts', status: 'added', oldOid: null, newOid: 'new-n' },
    ])
    expect((await source.analyze(files)).stats['src/a.ts']).toEqual({ additions: 1, deletions: 0 })
    const contents = await source.contents(files[0]!)
    expect([contents.old, contents.new]).toEqual([text('a\n'), text('a\nb\n')])
    expect(calls.filter((call) => call.path.includes('/compare/'))).toHaveLength(1)
  })
})
