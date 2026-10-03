import { describe, expect, it } from 'vitest'
import { hashBlob } from '../../src/git/hash'
import { createGitHubClient } from '../../src/github/client'
import { GitHubError } from '../../src/github/errors'
import { fixture, fixtureText, mockFetch, type MockRoute } from './mockFetch'

const ref = { owner: 'charlesabarnes', name: 'gangway' }
const HEAD = '118bade96cd67e73abb7a355f5fc5f6a846805b8'
const BASE = 'cc550430fddb0cdc88d38a7fd88b06ba043eee90'

const client = (routes: MockRoute[]) => {
  const mock = mockFetch(routes)
  return { gh: createGitHubClient({ token: 'github_pat_test', fetch: mock.fetch }), calls: mock.calls }
}

async function rejection(promise: Promise<unknown>): Promise<GitHubError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubError)
    return error as GitHubError
  }
  throw new Error('Expected the request to fail')
}

describe('GitHub client', () => {
  it('sends the token and API version, and reads the viewer and token expiry', async () => {
    const { gh, calls } = client([
      {
        match: /^\/user$/,
        body: { login: 'charlesabarnes', id: 1, name: 'Charles Barnes' },
        headers: { 'github-authentication-token-expiration': '2026-12-31 23:59:59 UTC' },
      },
    ])
    expect(await gh.viewer()).toEqual({
      login: 'charlesabarnes',
      name: 'Charles Barnes',
      tokenExpiresAt: '2026-12-31 23:59:59 UTC',
      scopes: null,
    })
    expect(calls[0]!.headers).toMatchObject({
      Authorization: 'Bearer github_pat_test',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    })
  })

  it('lists classic token scopes', async () => {
    const { gh } = client([{ match: /^\/user$/, body: { login: 'me' }, headers: { 'x-oauth-scopes': 'repo, read:org' } }])
    expect(await gh.viewer()).toMatchObject({ tokenExpiresAt: null, scopes: ['repo', 'read:org'] })
  })

  it('reads the default branch and branch head', async () => {
    const { gh, calls } = client([
      { match: /^\/repos\/charlesabarnes\/gangway$/, body: fixture('repo.json') },
      { match: /\/git\/ref\/heads\/master$/, body: fixture('ref-master.json') },
      { match: /\/git\/ref\/heads\/feat\/gone$/, status: 404, body: { message: 'Not Found' } },
    ])
    expect(await gh.repo(ref)).toMatchObject({ defaultBranch: 'master', fullName: 'charlesabarnes/gangway' })
    expect(await gh.branchHead(ref, 'master')).toBe(BASE)
    expect(await gh.branchHead(ref, 'feat/gone')).toBeNull()
    expect(calls[2]!.url.pathname).toBe('/repos/charlesabarnes/gangway/git/ref/heads/feat/gone')
  })

  it('treats a missing commit as not pushed', async () => {
    const { gh } = client([
      { match: new RegExp(`/commits/${HEAD}$`), body: { sha: HEAD } },
      { match: /\/commits\/0{40}$/, status: 422, body: { message: 'No commit found for SHA: 0000000' } },
    ])
    expect(await gh.commitExists(ref, HEAD)).toBe(true)
    expect(await gh.commitExists(ref, '0'.repeat(40))).toBe(false)
  })

  it('compares two commits and returns the merge base', async () => {
    const { gh, calls } = client([{ match: /\/compare\//, body: fixture('compare.json') }])
    const comparison = await gh.compare(ref, BASE, HEAD)
    expect(calls[0]!.url.pathname).toBe(`/repos/charlesabarnes/gangway/compare/${BASE}...${HEAD}`)
    expect(comparison).toMatchObject({ status: 'ahead', aheadBy: 5, behindBy: 0, mergeBaseSha: BASE })
    expect(comparison.files).toHaveLength(13)
    expect(comparison.files.find((file) => file.path === 'server/src/tls/dns/acme-dns.ts')).toMatchObject({
      status: 'added',
      previousPath: null,
    })
  })

  it('finds the open pull request for a branch', async () => {
    const { gh, calls } = client([
      { match: /\/pulls\?/, body: fixture('pulls-by-head.json') },
    ])
    const pr = await gh.openPullForBranch(ref, 'feat/acme-dns')
    expect(calls[0]!.url.searchParams.get('head')).toBe('charlesabarnes:feat/acme-dns')
    expect(calls[0]!.url.searchParams.get('state')).toBe('open')
    expect(pr).toEqual({
      number: 48,
      title: 'Get certificates through acme-dns when DNS is not on Cloudflare',
      htmlUrl: 'https://github.com/charlesabarnes/gangway/pull/48',
      draft: false,
      headSha: HEAD,
      headRef: 'feat/acme-dns',
      baseRef: 'master',
    })
  })

  it('returns null when no pull request is open', async () => {
    const { gh } = client([{ match: /\/pulls\?/, body: [] }])
    expect(await gh.openPullForBranch(ref, 'nothing')).toBeNull()
  })

  it('follows Link headers through every page of PR files', async () => {
    const files = fixture<unknown[]>('pull-files.json')
    const link = fixtureText('pull-files-link.txt').replace(/^Link:\s*/i, '').trim()
    const { gh, calls } = client([
      { match: /\/pulls\/48\/files\?per_page=10&page=2$/, body: files.slice(10) },
      { match: /\/pulls\/48\/files\?per_page=100$/, body: files.slice(0, 10), headers: { link } },
    ])
    const result = await gh.pullFiles(ref, 48)
    expect(calls.map((call) => call.url.search)).toEqual(['?per_page=100', '?per_page=10&page=2'])
    expect(result).toHaveLength(13)
    expect(result[0]).toMatchObject({ path: 'compose.yaml', status: 'modified' })
    expect(result.find((file) => file.path === 'server/src/boot/tls.ts')?.patch).toMatch(/^@@ -1,6 \+1,7 @@/)
  })

  it('decodes a base64 blob to the exact bytes', async () => {
    const blob = fixture<{ sha: string }>('blob-config.json')
    const { gh } = client([{ match: /\/git\/blobs\//, body: blob }])
    const bytes = await gh.blob(ref, blob.sha)
    expect(await hashBlob(bytes)).toBe(blob.sha)
  })

  it('lists a tree recursively', async () => {
    const { gh, calls } = client([{ match: /\/git\/trees\//, body: fixture('tree.json') }])
    const tree = await gh.tree(ref, BASE)
    expect(calls[0]!.url.searchParams.get('recursive')).toBe('1')
    expect(tree.truncated).toBe(false)
    expect(tree.entries.find((entry) => entry.path === 'server/src/config.ts')).toMatchObject({ type: 'blob' })
  })

  it('creates a pending review without an event and reads its comments back', async () => {
    const { gh, calls } = client([
      {
        method: 'POST',
        match: /\/pulls\/48\/reviews$/,
        body: { id: 99, state: 'PENDING', html_url: 'https://github.com/charlesabarnes/gangway/pull/48#pullrequestreview-99' },
      },
      { match: /\/pulls\/48\/reviews\/99\/comments/, body: fixture('review-comments.json') },
    ])
    const review = await gh.createPendingReview(ref, 48, {
      commitId: HEAD,
      body: '',
      comments: [{ path: 'server/src/config.ts', line: 152, side: 'RIGHT', body: '**nit:** naming' }],
    })
    expect(review).toEqual({ id: 99, state: 'PENDING', htmlUrl: expect.stringContaining('pullrequestreview-99') })
    expect(calls[0]!.body).toEqual({
      commit_id: HEAD,
      body: '',
      comments: [{ path: 'server/src/config.ts', line: 152, side: 'RIGHT', body: '**nit:** naming' }],
    })
    expect(calls[0]!.body).not.toHaveProperty('event')
    const comments = await gh.reviewComments(ref, 48, 99)
    expect(comments[0]).toMatchObject({ id: expect.any(Number), path: expect.any(String), side: 'RIGHT' })
  })

  describe('errors', () => {
    const failing = (status: number, headers: Record<string, string> = {}, body: unknown = { message: 'x' }) =>
      client([{ method: '*', match: /./, status, headers, body }]).gh

    it('reports a bad token on 401', async () => {
      const error = await rejection(failing(401, {}, { message: 'Bad credentials' }).viewer())
      expect(error.kind).toBe('bad-token')
      expect(error.message).toMatch(/token/)
    })

    it('reports a missing permission on 403', async () => {
      const error = await rejection(
        failing(403, { 'x-ratelimit-remaining': '4000' }, { message: 'Resource not accessible by personal access token' }).repo(ref),
      )
      expect(error.kind).toBe('forbidden')
      expect(error.message).toMatch(/permission/)
      expect(error.message).toMatch(/Resource not accessible by personal access token/)
    })

    it('reports a missing repo on 404', async () => {
      const error = await rejection(failing(404, {}, { message: 'Not Found' }).repo(ref))
      expect(error.kind).toBe('not-found')
      expect(error.message).toMatch(/repository/)
    })

    it('reports the rate limit with its reset time', async () => {
      const reset = Math.floor(Date.now() / 1000) + 600
      const error = await rejection(
        failing(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }, { message: 'API rate limit exceeded' }).repo(ref),
      )
      expect(error.kind).toBe('rate-limited')
      expect(error.resetAt?.getTime()).toBe(reset * 1000)
    })

    it('reports secondary rate limits from retry-after', async () => {
      const error = await rejection(failing(429, { 'retry-after': '30' }).repo(ref))
      expect(error.kind).toBe('rate-limited')
    })

    it('passes GitHub validation messages through on 422', async () => {
      const error = await rejection(
        failing(422, {}, { message: 'Unprocessable Entity', errors: ['User can only have one pending review per pull request'] })
          .createPendingReview(ref, 48, { commitId: HEAD, body: 'x', comments: [] }),
      )
      expect(error.kind).toBe('invalid')
      expect(error.message).toMatch(/one pending review/)
    })

    it('wraps network failures', async () => {
      const gh = createGitHubClient({
        token: 't',
        fetch: (async () => {
          throw new TypeError('Failed to fetch')
        }) as typeof fetch,
      })
      const error = await rejection(gh.viewer())
      expect(error.kind).toBe('network')
      expect(error.message).toMatch(/Failed to fetch/)
    })
  })
})
