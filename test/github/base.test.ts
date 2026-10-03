import { describe, expect, it, vi } from 'vitest'
import type { FileChange } from '../../src/git/types'
import { createGitHubClient } from '../../src/github/client'
import { checkFreshness, githubMergeBase } from '../../src/github/freshness'
import { githubBaseChanges, type BaseGit } from '../../src/github/remoteBase'
import { fixture, mockFetch } from './mockFetch'

const ref = { owner: 'charlesabarnes', name: 'gangway' }
const REMOTE_TIP = 'cc550430fddb0cdc88d38a7fd88b06ba043eee90'
const LOCAL_TIP = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const HEAD = '118bade96cd67e73abb7a355f5fc5f6a846805b8'

describe('checkFreshness', () => {
  const refRoute = { match: /\/git\/ref\/heads\/master$/, body: fixture('ref-master.json') }

  it('is fresh when local origin/<base> matches GitHub', async () => {
    const { fetch, calls } = mockFetch([refRoute])
    const gh = createGitHubClient({ token: 't', fetch })
    expect(await checkFreshness(gh, ref, { baseBranch: 'master', localTip: REMOTE_TIP, headSha: HEAD })).toEqual({
      kind: 'fresh',
      remoteTip: REMOTE_TIP,
    })
    expect(calls).toHaveLength(1)
  })

  it('is stale and pushed when GitHub knows HEAD', async () => {
    const { fetch } = mockFetch([refRoute, { match: new RegExp(`/commits/${HEAD}$`), body: { sha: HEAD } }])
    const gh = createGitHubClient({ token: 't', fetch })
    expect(await checkFreshness(gh, ref, { baseBranch: 'master', localTip: LOCAL_TIP, headSha: HEAD })).toEqual({
      kind: 'stale',
      localTip: LOCAL_TIP,
      remoteTip: REMOTE_TIP,
      headPushed: true,
    })
  })

  it('is stale and unpushed when GitHub does not know HEAD', async () => {
    const { fetch } = mockFetch([refRoute, { match: /\/commits\//, status: 422, body: { message: 'No commit found for SHA' } }])
    const gh = createGitHubClient({ token: 't', fetch })
    const result = await checkFreshness(gh, ref, { baseBranch: 'master', localTip: LOCAL_TIP, headSha: 'b'.repeat(40) })
    expect(result).toMatchObject({ kind: 'stale', headPushed: false })
  })

  it('notices a base branch GitHub does not have', async () => {
    const { fetch } = mockFetch([{ match: /\/git\/ref\/heads\//, status: 404, body: { message: 'Not Found' } }])
    const gh = createGitHubClient({ token: 't', fetch })
    expect(await checkFreshness(gh, ref, { baseBranch: 'trunk', localTip: LOCAL_TIP, headSha: HEAD })).toEqual({
      kind: 'no-remote-branch',
    })
  })

  it('takes the merge base from compare', async () => {
    const { fetch, calls } = mockFetch([{ match: /\/compare\//, body: fixture('compare.json') }])
    const gh = createGitHubClient({ token: 't', fetch })
    expect(await githubMergeBase(gh, ref, REMOTE_TIP, HEAD)).toBe(REMOTE_TIP)
    expect(calls[0]!.url.pathname).toMatch(`${REMOTE_TIP}...${HEAD}`)
  })
})

describe('githubBaseChanges', () => {
  const change = (path: string, status: FileChange['status'], oldOid: string | null, newOid: string | null): FileChange => ({
    path,
    status,
    oldOid,
    newOid,
  })

  const fakeGit = (overrides: Partial<BaseGit>): BaseGit & { added: Record<string, Uint8Array> } => {
    const added: Record<string, Uint8Array> = {}
    return {
      added,
      hasCommit: vi.fn(async () => true),
      changes: vi.fn(async () => []),
      changesAgainstOids: vi.fn(async () => []),
      missingBlobs: vi.fn(async () => []),
      addBlobs: vi.fn((blobs: Record<string, Uint8Array>) => Object.assign(added, blobs)),
      ...overrides,
    }
  }

  it('diffs locally when the merge base commit is local, and fetches only missing old blobs', async () => {
    const blob = fixture<{ sha: string }>('blob-config.json')
    const changes = [
      change('server/src/config.ts', 'modified', blob.sha, 'n1'),
      change('server/src/new.ts', 'added', null, 'n2'),
      change('server/src/settings.ts', 'modified', 'local-oid', 'n3'),
    ]
    const git = fakeGit({ changes: vi.fn(async () => changes), missingBlobs: vi.fn(async () => [blob.sha]) })
    const { fetch, calls } = mockFetch([{ match: new RegExp(`/git/blobs/${blob.sha}$`), body: blob }])
    const gh = createGitHubClient({ token: 't', fetch })

    expect(await githubBaseChanges(git, gh, ref, REMOTE_TIP)).toBe(changes)
    expect(git.changes).toHaveBeenCalledWith(REMOTE_TIP)
    expect(git.missingBlobs).toHaveBeenCalledWith([blob.sha, 'local-oid'])
    expect(calls.map((call) => call.url.pathname)).toEqual([`/repos/charlesabarnes/gangway/git/blobs/${blob.sha}`])
    expect(Object.keys(git.added)).toEqual([blob.sha])
  })

  it('lists the base tree from GitHub when the merge base is not local', async () => {
    const tree = fixture<{ tree: { path: string; type: string; sha: string }[] }>('tree.json')
    const git = fakeGit({ hasCommit: vi.fn(async () => false) })
    const { fetch } = mockFetch([{ match: /\/git\/trees\//, body: tree }])
    const gh = createGitHubClient({ token: 't', fetch })

    await githubBaseChanges(git, gh, ref, 'd'.repeat(40))
    const base = vi.mocked(git.changesAgainstOids).mock.calls[0]![0]
    expect(base['server/src/config.ts']).toBe(tree.tree.find((entry) => entry.path === 'server/src/config.ts')!.sha)
    expect(Object.keys(base)).not.toContain('server/src/tls')
    expect(git.changes).not.toHaveBeenCalled()
  })

  it('refuses a truncated tree', async () => {
    const git = fakeGit({ hasCommit: vi.fn(async () => false) })
    const { fetch } = mockFetch([{ match: /\/git\/trees\//, body: { sha: 'e'.repeat(40), truncated: true, tree: [] } }])
    const gh = createGitHubClient({ token: 't', fetch })
    await expect(githubBaseChanges(git, gh, ref, 'e'.repeat(40))).rejects.toThrow(/too large/)
  })
})
