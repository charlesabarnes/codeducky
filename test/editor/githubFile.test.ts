import { describe, expect, it } from 'vitest'
import { commitFile, defaultCommitMessage, prEditAccess, readBranchFile } from '../../src/editor/githubFile'
import { createGitHubClient } from '../../src/github/client'
import type { PullDetail } from '../../src/github/types'
import { mockFetch, type MockRoute } from '../github/mockFetch'

const base = { owner: 'acme', name: 'app' }
const target = { repo: base, branch: 'feature/retry' }
const LF = { bom: false, eol: '\n' as const }
const CONTENTS = /^\/repos\/acme\/app\/contents\/src\/a%20b\.ts$/

const client = (routes: MockRoute[]) => {
  const mock = mockFetch(routes)
  return { gh: createGitHubClient({ token: 'github_pat_test', fetch: mock.fetch }), calls: mock.calls }
}

const pull = (overrides: Partial<PullDetail> = {}): PullDetail => ({
  number: 7,
  title: 'Retry',
  htmlUrl: 'https://github.com/acme/app/pull/7',
  draft: false,
  headSha: 'h'.repeat(40),
  headRef: 'feature/retry',
  baseRef: 'main',
  body: '',
  state: 'open',
  author: 'someone',
  baseSha: 'b'.repeat(40),
  headRepo: 'acme/app',
  maintainerCanModify: false,
  labels: [],
  requestedReviewers: [],
  requestedTeams: [],
  additions: 0,
  deletions: 0,
  changedFiles: 1,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...overrides,
})

const repoRoute = (path: RegExp, push: boolean | undefined, status = 200): MockRoute => ({
  match: path,
  status,
  body: status === 200 ? { full_name: 'x/y', default_branch: 'main', private: false, html_url: '', ...(push === undefined ? {} : { permissions: { push } }) } : { message: 'Not Found' },
})

describe('commitFile', () => {
  it('PUTs the file to the head branch with the blob sha it replaces', async () => {
    const { gh, calls } = client([{ method: 'PUT', match: CONTENTS, body: { content: { sha: 'newblob' }, commit: { sha: 'c0ffee1234' } } }])
    const result = await commitFile(gh, target, 'src/a b.ts', { text: 'héllo\n', format: { bom: false, eol: '\r\n' }, sha: 'oldblob', message: 'Update src/a b.ts' })
    expect(result).toEqual({ kind: 'committed', commitSha: 'c0ffee1234', blobSha: 'newblob' })
    expect(calls[0]!.body).toEqual({
      message: 'Update src/a b.ts',
      branch: 'feature/retry',
      sha: 'oldblob',
      content: Buffer.from('héllo\r\n').toString('base64'),
    })
  })

  it('turns 409 and 422 into a conflict to reload from', async () => {
    for (const status of [409, 422]) {
      const { gh } = client([{ method: 'PUT', match: CONTENTS, status, body: { message: 'src/a b.ts does not match oldblob' } }])
      const result = await commitFile(gh, target, 'src/a b.ts', { text: 'x', format: LF, sha: 'oldblob', message: 'm' })
      expect(result.kind).toBe('conflict')
      if (result.kind === 'conflict') expect(result.message).toContain('Reload')
    }
  })

  it('explains a missing Contents: write permission', async () => {
    for (const status of [403, 404]) {
      const { gh } = client([{ method: 'PUT', match: CONTENTS, status, body: { message: 'Resource not accessible by personal access token' } }])
      const result = await commitFile(gh, target, 'src/a b.ts', { text: 'x', format: LF, sha: 'oldblob', message: 'm' })
      expect(result.kind).toBe('forbidden')
      if (result.kind !== 'forbidden') continue
      expect(result.message).toContain('Contents: read and write')
      expect(result.message).toContain('acme/app')
    }
  })

  it('lets other failures through', async () => {
    const { gh } = client([{ method: 'PUT', match: CONTENTS, status: 500, body: { message: 'boom' } }])
    await expect(commitFile(gh, target, 'src/a b.ts', { text: 'x', format: LF, sha: 'oldblob', message: 'm' })).rejects.toThrow(/500/)
  })

  it('prefills the message with the path', () => {
    expect(defaultCommitMessage('src/app.ts')).toBe('Update src/app.ts')
  })
})

describe('readBranchFile', () => {
  it('reads the file on the head branch, falling back to the blob for large files', async () => {
    const small = client([{ match: /\/contents\/src\/a%20b\.ts\?ref=feature%2Fretry$/, body: { sha: 's1', encoding: 'base64', content: Buffer.from('a\r\nb\r\n').toString('base64') } }])
    expect(await readBranchFile(small.gh, target, 'src/a b.ts')).toEqual({ sha: 's1', text: 'a\nb\n', format: { bom: false, eol: '\r\n' } })

    const large = client([
      { match: /\/contents\//, body: { sha: 's2', encoding: 'none', content: '' } },
      { match: /\/git\/blobs\/s2$/, body: { encoding: 'base64', content: Buffer.from('big\n').toString('base64') } },
    ])
    expect((await readBranchFile(large.gh, target, 'src/a b.ts')).text).toBe('big\n')
  })
})

describe('prEditAccess', () => {
  it('allows a same-repository pull request when the user can push', async () => {
    const { gh } = client([repoRoute(/^\/repos\/acme\/app$/, true)])
    expect(await prEditAccess(gh, base, pull())).toEqual({ kind: 'ok', target })
  })

  it('blocks a same-repository pull request without push access', async () => {
    const { gh } = client([repoRoute(/^\/repos\/acme\/app$/, false)])
    expect(await prEditAccess(gh, base, pull())).toMatchObject({ kind: 'blocked', reason: expect.stringContaining('cannot push to acme/app') })
  })

  it('commits to a fork the user can push to', async () => {
    const { gh } = client([repoRoute(/^\/repos\/someone\/app$/, true)])
    expect(await prEditAccess(gh, base, pull({ headRepo: 'someone/app' }))).toEqual({ kind: 'ok', target: { repo: { owner: 'someone', name: 'app' }, branch: 'feature/retry' } })
  })

  it('uses maintainer edits on a fork when the user can push to the base', async () => {
    const { gh } = client([repoRoute(/^\/repos\/someone\/app$/, false), repoRoute(/^\/repos\/acme\/app$/, true)])
    expect((await prEditAccess(gh, base, pull({ headRepo: 'someone/app', maintainerCanModify: true }))).kind).toBe('ok')
  })

  it('blocks a fork the user cannot push to, and says why', async () => {
    const { gh } = client([repoRoute(/^\/repos\/someone\/app$/, undefined, 404)])
    const access = await prEditAccess(gh, base, pull({ headRepo: 'someone/app' }))
    expect(access).toMatchObject({ kind: 'blocked', reason: expect.stringContaining('fork someone/app') })
    if (access.kind === 'blocked') expect(access.reason).toContain('not allowed edits by maintainers')
  })

  it('blocks deleted forks and closed pull requests without asking GitHub', async () => {
    const { gh, calls } = client([])
    expect((await prEditAccess(gh, base, pull({ headRepo: null }))).kind).toBe('blocked')
    expect((await prEditAccess(gh, base, pull({ state: 'merged' }))).kind).toBe('blocked')
    expect(calls).toHaveLength(0)
  })
})
