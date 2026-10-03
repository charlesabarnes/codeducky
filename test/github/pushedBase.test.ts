import { describe, expect, it, vi } from 'vitest'
import { createGitHubClient } from '../../src/github/client'
import { ANCESTOR_LIMIT, findGitHubBase, pushedAncestor, type AncestryGit } from '../../src/github/pushedBase'
import { mockFetch, type MockRoute } from './mockFetch'

const ref = { owner: 'me', name: 'repo' }
const sha = (n: number) => n.toString(16).padStart(40, '0')
const chain = (length: number) => Array.from({ length }, (_, i) => sha(i + 1))
const TIP = 'f'.repeat(40)
const LOCAL_MB = 'e'.repeat(40)

const fakeGit = (commits: string[]): AncestryGit => ({
  firstParents: vi.fn(async (limit: number) => commits.slice(0, limit)),
  resolveBase: vi.fn(async () => ({ mergeBaseSha: LOCAL_MB })),
})

/** GitHub knows exactly the commits in `pushed`. */
const commitRoutes = (pushed: string[]): MockRoute[] => [
  ...pushed.map((s) => ({ match: new RegExp(`/commits/${s}$`), body: { sha: s } })),
  { match: /\/commits\//, status: 422, body: { message: 'No commit found for SHA' } },
]

const commitCalls = (calls: { url: URL }[]) => calls.filter((call) => call.url.pathname.includes('/commits/'))

describe('pushedAncestor', () => {
  it('uses HEAD with a single request when it is pushed', async () => {
    const commits = chain(5)
    const { fetch, calls } = mockFetch(commitRoutes(commits))
    const gh = createGitHubClient({ token: 't', fetch })
    expect(await pushedAncestor(gh, ref, fakeGit(commits), 'main')).toEqual({ headSha: commits[0], sha: commits[0], fallback: false })
    expect(calls).toHaveLength(1)
  })

  it('finds HEAD~2 when the last two commits are local only', async () => {
    const commits = chain(8)
    const { fetch } = mockFetch(commitRoutes(commits.slice(2)))
    const gh = createGitHubClient({ token: 't', fetch })
    expect(await pushedAncestor(gh, ref, fakeGit(commits), 'main')).toEqual({ headSha: commits[0], sha: commits[2], fallback: false })
  })

  it('finds the fork point when nothing on the branch is pushed', async () => {
    const commits = chain(4)
    const { fetch } = mockFetch(commitRoutes([commits[3]!]))
    const gh = createGitHubClient({ token: 't', fetch })
    expect(await pushedAncestor(gh, ref, fakeGit(commits), 'main')).toMatchObject({ sha: commits[3], fallback: false })
  })

  it('stops after the cap and falls back to the local merge base', async () => {
    const commits = chain(ANCESTOR_LIMIT + 30)
    const git = fakeGit(commits)
    const { fetch, calls } = mockFetch(commitRoutes([]))
    const gh = createGitHubClient({ token: 't', fetch })
    expect(await pushedAncestor(gh, ref, git, 'main')).toEqual({ headSha: commits[0], sha: LOCAL_MB, fallback: true })
    expect(git.firstParents).toHaveBeenCalledWith(ANCESTOR_LIMIT)
    expect(commitCalls(calls)).toHaveLength(ANCESTOR_LIMIT)
    expect(git.resolveBase).toHaveBeenCalledWith('main')
  })

  it('does not check past the first batch that has a pushed commit', async () => {
    const commits = chain(40)
    const { fetch, calls } = mockFetch(commitRoutes([commits[3]!]))
    const gh = createGitHubClient({ token: 't', fetch })
    await pushedAncestor(gh, ref, fakeGit(commits), 'main')
    expect(commitCalls(calls).length).toBeLessThanOrEqual(11)
  })

  it('passes GitHub errors on instead of treating them as unpushed', async () => {
    const { fetch } = mockFetch([{ match: /\/commits\//, status: 401, body: { message: 'Bad credentials' } }])
    const gh = createGitHubClient({ token: 't', fetch })
    await expect(pushedAncestor(gh, ref, fakeGit(chain(3)), 'main')).rejects.toThrow(/401/)
  })
})

describe('findGitHubBase', () => {
  it('compares the GitHub tip with the last pushed commit and takes its merge base', async () => {
    const commits = chain(6)
    const { fetch, calls } = mockFetch([
      { match: /\/git\/ref\/heads\/main$/, body: { object: { sha: TIP } } },
      { match: /\/compare\//, body: { status: 'diverged', ahead_by: 1, behind_by: 2, merge_base_commit: { sha: commits[4] } } },
      ...commitRoutes(commits.slice(2)),
    ])
    const gh = createGitHubClient({ token: 't', fetch })
    expect(await findGitHubBase(gh, ref, fakeGit(commits), { baseBranch: 'main' })).toEqual({
      headSha: commits[0],
      baseSha: commits[4],
      githubBase: { branch: 'main', tipSha: TIP, pushedSha: commits[2] },
    })
    expect(calls.at(-1)!.url.pathname).toBe(`/repos/me/repo/compare/${TIP}...${commits[2]}`)
  })

  it('leaves pushedSha out when HEAD is pushed, and reuses a known tip', async () => {
    const commits = chain(3)
    const { fetch, calls } = mockFetch([
      { match: /\/compare\//, body: { status: 'ahead', ahead_by: 3, behind_by: 0, merge_base_commit: { sha: TIP } } },
      ...commitRoutes(commits),
    ])
    const gh = createGitHubClient({ token: 't', fetch })
    const base = await findGitHubBase(gh, ref, fakeGit(commits), { baseBranch: 'main', remoteTip: TIP })
    expect(base.githubBase).toEqual({ branch: 'main', tipSha: TIP })
    expect(calls.some((call) => call.url.pathname.includes('/git/ref/'))).toBe(false)
  })

  it('fails when GitHub has no such base branch', async () => {
    const { fetch } = mockFetch([{ match: /\/git\/ref\/heads\//, status: 404, body: { message: 'Not Found' } }])
    const gh = createGitHubClient({ token: 't', fetch })
    await expect(findGitHubBase(gh, ref, fakeGit(chain(2)), { baseBranch: 'trunk' })).rejects.toThrow(/no branch named trunk/)
  })

  it('fails when GitHub cannot be reached', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof globalThis.fetch
    const gh = createGitHubClient({ token: 't', fetch })
    await expect(findGitHubBase(gh, ref, fakeGit(chain(2)), { baseBranch: 'main' })).rejects.toThrow(/Could not reach GitHub/)
  })
})
