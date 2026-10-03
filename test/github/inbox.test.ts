import { describe, expect, it } from 'vitest'
import { createGitHubClient } from '../../src/github/client'
import { GitHubError } from '../../src/github/errors'
import { ciState, fetchInbox, inboxQueries, inboxSnapshotItems, MAX_SNAPSHOT_ITEMS, sameItems } from '../../src/github/inbox'
import { mockFetch, type MockRoute } from './mockFetch'

const NOW = Date.parse('2026-10-03T12:00:00Z')

const pr = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/acme/api/pull/${number}`,
  isDraft: false,
  state: 'OPEN',
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-02T10:00:00Z',
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  author: { login: 'octo' },
  repository: { name: 'api', owner: { login: 'acme' } },
  viewerLatestReview: null,
  pending: { totalCount: 0 },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  ...extra,
})

const client = (routes: MockRoute[]) => {
  const mock = mockFetch(routes)
  return { gh: createGitHubClient({ token: 't', fetch: mock.fetch }), calls: mock.calls }
}

describe('inbox', () => {
  it('asks for all sections in one GraphQL request with the search qualifiers', async () => {
    const { gh, calls } = client([
      {
        method: 'POST',
        match: /^\/graphql$/,
        body: {
          data: {
            viewer: { login: 'me' },
            requested: {
              issueCount: 3,
              nodes: [
                pr(1),
                pr(2, { isDraft: true, pending: { totalCount: 1 }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } }),
                {},
              ],
            },
            direct: { nodes: [{ url: 'https://github.com/acme/api/pull/1' }] },
            mine: { issueCount: 1, nodes: [pr(5, { author: { login: 'me' }, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } })] },
            reviewed: { issueCount: 1, nodes: [pr(9, { viewerLatestReview: { state: 'APPROVED' }, state: 'MERGED' })] },
          },
        },
      },
    ])
    const inbox = await fetchInbox(gh, NOW)
    const sent = calls[0]!.body as { query: string; variables: Record<string, string> }
    expect(sent.variables).toEqual(inboxQueries(NOW))
    expect(sent.variables.requested).toContain('review-requested:@me')
    expect(sent.variables.direct).toContain('user-review-requested:@me')
    expect(sent.variables.mine).toContain('author:@me')
    expect(sent.variables.reviewed).toContain('reviewed-by:@me')
    expect(sent.variables.reviewed).toContain('updated:>=2026-09-03')

    expect(inbox.viewer).toBe('me')
    expect(inbox.totals).toEqual({ requested: 3, mine: 1, reviewed: 1 })
    // The empty node (a repo the token cannot read) is dropped.
    expect(inbox.sections.requested.map((row) => row.number)).toEqual([1, 2])
    expect(inbox.sections.requested[0]).toMatchObject({ owner: 'acme', name: 'api', ci: 'pass', viaTeam: false, pendingReview: false, additions: 10, deletions: 2, changedFiles: 3 })
    expect(inbox.sections.requested[1]).toMatchObject({ draft: true, ci: 'fail', viaTeam: true, pendingReview: true })
    expect(inbox.sections.mine[0]).toMatchObject({ ci: 'none', viaTeam: false })
    expect(inbox.sections.reviewed[0]).toMatchObject({ myReview: 'APPROVED', state: 'MERGED' })
  })

  it('keeps partial results when some repositories are not readable', async () => {
    const { gh } = client([
      {
        method: 'POST',
        match: /^\/graphql$/,
        body: {
          data: { viewer: { login: 'me' }, requested: { issueCount: 1, nodes: [pr(1)] }, direct: null, mine: null, reviewed: null },
          errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by personal access token' }],
        },
      },
    ])
    const inbox = await fetchInbox(gh, NOW)
    expect(inbox.sections.requested).toHaveLength(1)
    expect(inbox.sections.mine).toEqual([])
  })

  it('reports a token without access as forbidden', async () => {
    const { gh } = client([
      { method: 'POST', match: /^\/graphql$/, body: { data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by personal access token' }] } },
    ])
    const error = await fetchInbox(gh, NOW).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GitHubError)
    expect((error as GitHubError).kind).toBe('forbidden')
    expect((error as GitHubError).message).toMatch(/fine-grained token must include/)
  })

  it('reports a REST 403 as forbidden too', async () => {
    const { gh } = client([{ method: 'POST', match: /^\/graphql$/, status: 403, body: { message: 'Forbidden' }, headers: { 'x-ratelimit-remaining': '10' } }])
    const error = (await fetchInbox(gh, NOW).catch((e: unknown) => e)) as GitHubError
    expect(error.kind).toBe('forbidden')
  })

  it('maps check rollups', () => {
    expect(['SUCCESS', 'FAILURE', 'ERROR', 'PENDING', 'EXPECTED', null].map(ciState)).toEqual(['pass', 'fail', 'fail', 'pending', 'pending', 'none'])
  })

  it('makes a small synced snapshot', () => {
    const row = { owner: 'acme', name: 'api', number: 1, title: 'T', url: 'u', author: 'octo', createdAt: '', updatedAt: '2026-10-02T10:00:00Z', draft: false, state: 'OPEN' as const, additions: 1, deletions: 1, changedFiles: 1, ci: 'pass' as const, pendingReview: false, myReview: null, viaTeam: false }
    const items = inboxSnapshotItems({
      viewer: 'me',
      fetchedAt: NOW,
      totals: { requested: 1, mine: 200, reviewed: 0 },
      sections: { requested: [row], mine: Array.from({ length: 200 }, (_, i) => ({ ...row, number: i + 2 })), reviewed: [] },
    })
    expect(items[0]).toEqual({ repo: 'acme/api', number: 1, title: 'T', author: 'octo', url: 'u', updatedAt: '2026-10-02T10:00:00Z', section: 'requested' })
    expect(items).toHaveLength(MAX_SNAPSHOT_ITEMS)
    expect(sameItems(items, [...items])).toBe(true)
    expect(sameItems(undefined, items)).toBe(false)
  })
})
