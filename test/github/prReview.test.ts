import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { RubberduckDb } from '../../src/db/db'
import type { Note } from '../../src/db/schema'
import { placeNotes } from '../../src/github/push'
import {
  archiveWithReview,
  needsBody,
  preparePrPush,
  pushToPendingReview,
  reviewSummary,
  submitBody,
  submitPrReview,
  unpushedNotes,
} from '../../src/github/prReview'
import { reviewerStates } from '../../src/github/reviewers'
import type { PendingReview } from '../../src/github/threads'
import type { PullDetail, PullFile } from '../../src/github/types'
import { fakeGitHub } from './fakeGitHub'

const dbs: RubberduckDb[] = []
afterEach(async () => {
  await Promise.all(dbs.splice(0).map((db) => db.delete()))
})

const ref = { owner: 'acme', name: 'api' }
const HEAD = 'h'.repeat(40)
const pull = { number: 7, headSha: HEAD, title: 'T', htmlUrl: 'https://github.com/acme/api/pull/7', draft: false, headRef: 'f', baseRef: 'main', author: 'octo', requestedReviewers: [], requestedTeams: [] } as unknown as PullDetail
const files: PullFile[] = [{ path: 'src/a.ts', previousPath: null, status: 'modified', patch: '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three' }]

const note = (id: string, extra: Partial<Note> = {}): Note => ({
  id,
  sessionId: 's1',
  path: 'src/a.ts',
  anchor: { line: 2, side: 'new', text: 'TWO', before: ['one'], after: ['three'] },
  body: `Body ${id}`,
  severity: 'issue',
  status: 'open',
  source: 'me',
  createdAt: 1,
  updatedAt: 1,
  ...extra,
})

async function seeded(notes: Note[]) {
  const db = new RubberduckDb(`pr-review-${Math.random()}`)
  dbs.push(db)
  await db.sessions.add({ id: 's1', repoId: 'gh:acme/api', branch: 'f', headSha: HEAD, baseSha: 'm', baseSource: 'github', source: 'github-pr', startedAt: 1, status: 'active', pr: { ...ref, number: 7 } })
  await db.notes.bulkAdd(notes)
  return db
}

const offDiff = note('n-off', { path: 'src/other.ts', severity: 'nit', body: 'Not in the PR' })

function reviewServer() {
  return fakeGitHub(({ method, path, body }) => {
    if (method === 'POST' && path === '/repos/acme/api/pulls/7/reviews') return { body: { id: 41, state: body!.event ? 'COMMENTED' : 'PENDING', html_url: 'https://github.com/acme/api/pull/7#pullrequestreview-41' } }
    if (method === 'POST' && path === '/repos/acme/api/pulls/7/reviews/9/events') return { body: { id: 9, state: 'APPROVED', html_url: 'https://github.com/acme/api/pull/7#pullrequestreview-9' } }
    if (method === 'PUT' && path === '/repos/acme/api/pulls/7/reviews/9') return { body: { id: 9 } }
    if (method === 'POST' && path === '/graphql') return { body: { data: { addPullRequestReviewThread: { thread: { comments: { nodes: [{ databaseId: 777 }] } } } } } }
    return undefined
  })
}

const pending: PendingReview = { id: 'PRR_9', databaseId: 9, body: 'Started on GitHub', comments: 1, url: 'https://github.com/acme/api/pull/7#pullrequestreview-9' }

describe('reviewing a pull request', () => {
  it('summarizes open notes worst first', () => {
    const summary = reviewSummary([note('a', { severity: 'nit', body: 'Rename this' }), note('b', { severity: 'blocker', body: 'Breaks totals\nmore' }), note('c', { status: 'resolved' })])
    expect(summary).toBe('2 notes: 1 blocker, 1 nit.\n\n- **blocker** `src/a.ts:2` Breaks totals\n- **nit** `src/a.ts:2` Rename this')
    expect(reviewSummary([])).toBe('')
  })

  it('previews pushes against the PR diff without a branch lookup', () => {
    const lookup = preparePrPush(pull, files, [note('a'), offDiff, note('r', { status: 'resolved' })])
    expect(lookup.kind).toBe('ready')
    if (lookup.kind !== 'ready') return
    expect(lookup.preview.localHead).toBe(HEAD)
    expect(lookup.preview.placement.placed.map((p) => p.comment)).toEqual([{ path: 'src/a.ts', line: 2, side: 'RIGHT', body: '**issue:** Body a' }])
    expect(lookup.preview.placement.unplaced.map((u) => u.note.id)).toEqual(['n-off'])
  })

  it('creates and submits a review in one call when there is no pending review', async () => {
    const db = await seeded([note('a'), offDiff])
    const { gh, calls } = reviewServer()
    const toSend = unpushedNotes(await db.notes.toArray())
    const result = await submitPrReview(db, gh, ref, pull, null, { event: 'COMMENT', body: 'Looks close.', placement: placeNotes(toSend, files) })
    expect(calls).toHaveLength(1)
    const sent = calls[0]!.body!
    expect(sent.event).toBe('COMMENT')
    expect(sent.commit_id).toBe(HEAD)
    expect(sent.comments).toEqual([{ path: 'src/a.ts', line: 2, side: 'RIGHT', body: '**issue:** Body a' }])
    expect(sent.body).toMatch(/^Looks close\.\n\nNotes that do not map onto the diff:/)
    expect(sent.body).toContain('src/other.ts')
    expect(result).toMatchObject({ state: 'COMMENTED', comments: 1 })
    expect((await db.notes.get('a'))!.github).toEqual({ reviewId: 41, commentId: undefined })
    expect(unpushedNotes(await db.notes.toArray())).toEqual([])

    await archiveWithReview(db, 's1', result, 1234)
    expect(await db.sessions.get('s1')).toMatchObject({ status: 'archived', review: { state: 'COMMENTED', at: 1234, url: expect.stringContaining('pullrequestreview-41') } })
  })

  it('adds unpushed notes to the pending review, then submits it (approve)', async () => {
    const db = await seeded([note('a')])
    const { gh, calls } = reviewServer()
    const result = await submitPrReview(db, gh, ref, pull, pending, { event: 'APPROVE', body: '', placement: placeNotes([note('a')], files) })
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /graphql', 'POST /repos/acme/api/pulls/7/reviews/9/events'])
    expect(calls[0]!.body!.variables).toEqual({ review: 'PRR_9', path: 'src/a.ts', line: 2, side: 'RIGHT', body: '**issue:** Body a' })
    expect(calls[1]!.body).toEqual({ event: 'APPROVE', body: '' })
    expect(result.state).toBe('APPROVED')
  })

  it('requests changes with only a summary', async () => {
    const db = await seeded([])
    const { gh, calls } = reviewServer()
    const result = await submitPrReview(db, gh, ref, pull, null, { event: 'REQUEST_CHANGES', body: 'Needs tests.', placement: null })
    expect(calls[0]!.body).toMatchObject({ event: 'REQUEST_CHANGES', body: 'Needs tests.', comments: [] })
    expect(result.state).toBe('CHANGES_REQUESTED')
  })

  it('knows when GitHub needs a body', () => {
    expect(needsBody({ event: 'COMMENT', body: ' ', placement: null }, 0)).toBe(true)
    expect(needsBody({ event: 'COMMENT', body: ' ', placement: null }, 2)).toBe(false)
    expect(needsBody({ event: 'APPROVE', body: '', placement: null }, 0)).toBe(false)
    expect(needsBody({ event: 'REQUEST_CHANGES', body: '', placement: placeNotes([note('a')], files) }, 0)).toBe(false)
    expect(submitBody({ event: 'COMMENT', body: '', placement: placeNotes([offDiff], files) })).toMatch(/^Notes that do not map/)
  })

  it('pushes notes into an existing pending review', async () => {
    const db = await seeded([note('a'), offDiff])
    const { gh, calls } = reviewServer()
    const placement = placeNotes([note('a'), offDiff], files)
    const result = await pushToPendingReview(db, gh, ref, 7, pending, { placed: placement.placed, bodyNotes: placement.unplaced.map((u) => u.note) })
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /graphql', 'PUT /repos/acme/api/pulls/7/reviews/9'])
    expect(calls[1]!.body!.body).toMatch(/^Started on GitHub\n\nNotes that do not map onto the diff:/)
    expect(result).toMatchObject({ review: { id: 9, state: 'PENDING' }, linked: 1 })
    expect((await db.notes.get('a'))!.github).toEqual({ reviewId: 9, commentId: 777 })
    expect((await db.notes.get('n-off'))!.github).toMatchObject({ reviewId: 9 })
  })

  it('shows each reviewer the way GitHub does', () => {
    const review = (author: string, state: string) => ({ id: 1, nodeId: null, author, state, body: '', submittedAt: '', htmlUrl: '', commitId: null })
    const states = reviewerStates({ author: 'octo', requestedReviewers: ['carol'], requestedTeams: ['core'] }, [
      review('alice', 'CHANGES_REQUESTED'),
      review('alice', 'COMMENTED'),
      review('bob', 'COMMENTED'),
      review('carol', 'APPROVED'),
      review('octo', 'COMMENTED'),
      review('dave', 'APPROVED'),
      review('dave', 'DISMISSED'),
    ])
    expect(states).toEqual([
      { login: 'alice', state: 'CHANGES_REQUESTED', team: false },
      { login: 'bob', state: 'COMMENTED', team: false },
      { login: 'carol', state: 'REQUESTED', team: false },
      { login: 'dave', state: 'DISMISSED', team: false },
      { login: 'core', state: 'REQUESTED', team: true },
    ])
  })
})
