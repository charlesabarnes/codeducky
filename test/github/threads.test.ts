import { describe, expect, it } from 'vitest'
import { addThreadToReview, fetchThreads, orderThreads, placeThreads, replyToThread, setThreadResolved, toThread } from '../../src/github/threads'
import { fakeGitHub } from './fakeGitHub'

const ref = { owner: 'acme', name: 'api' }

const comment = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  databaseId: Number(id.replace(/\D/g, '')) || 1,
  body: `Body ${id}`,
  createdAt: '2026-10-01T10:00:00Z',
  url: `https://github.com/acme/api/pull/7#discussion_r${id}`,
  state: 'SUBMITTED',
  author: { login: 'octo' },
  ...extra,
})

type RawThread = Parameters<typeof toThread>[0]

const thread = (id: string, extra: Record<string, unknown> = {}): RawThread => ({
  id,
  path: 'src/a.ts',
  line: 12,
  originalLine: 10,
  startLine: null,
  diffSide: 'RIGHT',
  subjectType: 'LINE',
  isResolved: false,
  isOutdated: false,
  viewerCanReply: true,
  viewerCanResolve: true,
  viewerCanUnresolve: false,
  resolvedBy: null,
  comments: { nodes: [comment(`${id}-c1`)] },
  ...extra,
}) as RawThread

const page = (nodes: unknown[], hasNextPage: boolean, endCursor: string | null, pending: unknown[] = []) => ({
  data: {
    viewer: { login: 'me' },
    repository: { pullRequest: { id: 'PR_1', pending: { nodes: pending }, reviewThreads: { pageInfo: { hasNextPage, endCursor }, nodes } } },
  },
})

describe('review threads', () => {
  it('pages through threads and finds your pending review', async () => {
    const { gh, calls } = fakeGitHub(({ body }) => {
      const after = (body!.variables as { after: string | null }).after
      return {
        body:
          after === null
            ? page([thread('T1'), thread('T2', { isOutdated: true, line: null, diffSide: 'LEFT' })], true, 'c1', [
                { id: 'PRR_9', databaseId: 9, body: 'Draft', url: 'u', comments: { totalCount: 2 } },
              ])
            : page([thread('T3', { subjectType: 'FILE', line: null }), null], false, null),
      }
    })
    const result = await fetchThreads(gh, ref, 7)
    expect(calls).toHaveLength(2)
    expect((calls[1]!.body!.variables as Record<string, unknown>).after).toBe('c1')
    expect(result.viewer).toBe('me')
    expect(result.pullId).toBe('PR_1')
    expect(result.pendingReview).toEqual({ id: 'PRR_9', databaseId: 9, body: 'Draft', comments: 2, url: 'u' })
    expect(result.threads.map((t) => t.id)).toEqual(['T1', 'T2', 'T3'])
    expect(result.threads[0]).toMatchObject({ side: 'new', line: 12, canResolve: true, comments: [{ author: 'octo', pending: false }] })
    expect(result.threads[1]).toMatchObject({ side: 'old', line: null, isOutdated: true })
    expect(result.threads[2]).toMatchObject({ fileLevel: true })
  })

  it('fails clearly when the pull request is missing', async () => {
    const { gh } = fakeGitHub(() => ({ body: { data: { viewer: { login: 'me' }, repository: { pullRequest: null } } } }))
    await expect(fetchThreads(gh, ref, 99)).rejects.toThrow(/#99 was not found/)
  })

  it('puts current threads on their lines and lists outdated and file threads', () => {
    const threads = [
      toThread(thread('A')),
      toThread(thread('B', { line: 12 })),
      toThread(thread('C', { diffSide: 'LEFT', line: 4 })),
      toThread(thread('D', { isOutdated: true, line: 30 })),
      toThread(thread('E', { subjectType: 'FILE', line: null })),
    ]
    // An outdated thread drops its stale line even if GitHub still sent one.
    expect(threads[3]!.line).toBeNull()
    const placed = placeThreads(threads)
    expect([...placed.byLine.keys()]).toEqual(['new:12', 'old:4'])
    expect(placed.byLine.get('new:12')!.map((t) => t.id)).toEqual(['A', 'B'])
    expect(placed.listed.map((t) => t.id)).toEqual(['D', 'E'])
  })

  it('orders threads by file order, listed ones first, then by line', () => {
    const threads = [
      toThread(thread('late', { path: 'b.ts', line: 50 })),
      toThread(thread('early', { path: 'b.ts', line: 2 })),
      toThread(thread('outdated', { path: 'b.ts', isOutdated: true })),
      toThread(thread('first', { path: 'a.ts', line: 9 })),
      toThread(thread('elsewhere', { path: 'not-in-diff.ts' })),
    ]
    expect(orderThreads(threads, ['a.ts', 'b.ts']).map((t) => t.id)).toEqual(['first', 'outdated', 'early', 'late'])
  })

  it('replies, resolves and unresolves through GraphQL mutations', async () => {
    const { gh, calls } = fakeGitHub(({ body }) => {
      const query = body!.query as string
      if (query.includes('addPullRequestReviewThreadReply')) return { body: { data: { addPullRequestReviewThreadReply: { comment: comment('R1', { body: 'Thanks' }) } } } }
      if (query.includes('unresolveReviewThread')) return { body: { data: { unresolveReviewThread: { thread: { id: 'T1', isResolved: false } } } } }
      if (query.includes('resolveReviewThread')) return { body: { data: { resolveReviewThread: { thread: { id: 'T1', isResolved: true } } } } }
      if (query.includes('addPullRequestReviewThread(')) return { body: { data: { addPullRequestReviewThread: { thread: { comments: { nodes: [{ databaseId: 555 }] } } } } } }
      return undefined
    })
    expect(await replyToThread(gh, 'T1', 'Thanks')).toMatchObject({ body: 'Thanks', author: 'octo' })
    expect(calls[0]!.body!.variables).toEqual({ thread: 'T1', body: 'Thanks' })
    expect(await setThreadResolved(gh, 'T1', true)).toBe(true)
    expect(await setThreadResolved(gh, 'T1', false)).toBe(false)
    expect((calls[1]!.body!.query as string)).toMatch(/resolveReviewThread\(input: \{ threadId: \$thread \}\)/)
    expect((calls[2]!.body!.query as string)).toMatch(/unresolveReviewThread/)
    expect(await addThreadToReview(gh, 'PRR_9', { path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'x' })).toBe(555)
    expect(calls[3]!.body!.variables).toEqual({ review: 'PRR_9', path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'x' })
  })

  it('surfaces mutation errors', async () => {
    const { gh } = fakeGitHub(() => ({ body: { data: { resolveReviewThread: null }, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by personal access token' }] } }))
    await expect(setThreadResolved(gh, 'T1', true)).rejects.toMatchObject({ kind: 'forbidden' })
  })
})
