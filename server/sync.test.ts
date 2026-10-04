import { afterEach, describe, expect, it } from 'bun:test'
import { pairId, SYNC_PAGE_SIZE, type SyncResponse, type WireChange } from '../shared/sync'
import { readRecord, writeRecord } from './records/store'
import { createUserSession, login, makeApp, request } from './testing'
import { ADMIN_USER_ID } from './users/store'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

async function setup() {
  const made = makeApp()
  cleanups.push(made.cleanup)
  const token = await login(made.app)
  const pushAs = (as: string) => async (changes: unknown[], cursor = 0) => {
    const res = await request(made.app, 'POST', '/api/sync', { cursor, changes }, as)
    expect(res.status).toBe(200)
    return (await res.json()) as SyncResponse
  }
  return { ...made, token, push: pushAs(token), pushAs }
}

const repo = (changedAt: number, name = 'codeducky'): WireChange => ({
  kind: 'repos',
  id: 'gh:charlesabarnes/codeducky',
  changedAt,
  deleted: false,
  data: { owner: 'charlesabarnes', name, folderName: 'codeducky', baseBranch: 'main', lastOpenedAt: 1, checklistIds: [] },
})

const view = (changedAt: number, viewed: boolean): WireChange => ({
  kind: 'fileViews',
  id: pairId('s1', 'src/a.ts'),
  changedAt,
  deleted: false,
  data: { sessionId: 's1', path: 'src/a.ts', contentHash: 'h', viewed },
})

describe('sync', () => {
  it('stores pushed records and returns them in the change feed', async () => {
    const { push } = await setup()
    const reply = await push([repo(10), view(10, true)])
    expect(reply.rejected).toEqual([])
    expect(reply.changes.map((c) => [c.kind, c.rev])).toEqual([
      ['repos', 1],
      ['fileViews', 2],
    ])
    expect(reply.changes[0]!.data).toMatchObject({ name: 'codeducky' })
    expect(reply.newCursor).toBe(2)
    expect((await push([], 2)).changes).toEqual([])
  })

  it('keeps the newest write per record, and lets a delete win a tie', async () => {
    const { push, db } = await setup()
    await push([repo(20, 'newer')])
    await push([repo(10, 'older')])
    expect(readRecord(db, ADMIN_USER_ID, 'repos', repo(0).id)?.data).toMatchObject({ name: 'newer' })

    await push([{ kind: 'repos', id: repo(0).id, changedAt: 20, deleted: true }])
    const stored = readRecord(db, ADMIN_USER_ID, 'repos', repo(0).id)!
    expect(stored.deleted).toBe(true)
    expect(stored.data).toBeUndefined()

    await push([repo(19, 'stale edit')])
    expect(readRecord(db, ADMIN_USER_ID, 'repos', repo(0).id)?.deleted).toBe(true)
    await push([repo(21, 'revived')])
    expect(readRecord(db, ADMIN_USER_ID, 'repos', repo(0).id)).toMatchObject({ deleted: false, data: { name: 'revived' } })
  })

  it('rejects invalid records one by one and applies the rest', async () => {
    const { push } = await setup()
    const reply = await push([
      repo(10),
      { kind: 'notes', id: 'n1', changedAt: 10, deleted: false, data: { sessionId: 's1' } },
      { kind: 'secrets', id: 'x', changedAt: 10, deleted: false, data: {} },
      { ...view(10, true), id: pairId('s2', 'src/a.ts') },
      { kind: 'sessions', id: 's9', changedAt: 10, deleted: true },
    ])
    expect(reply.rejected.map((r) => [r.kind, r.id])).toEqual([
      ['notes', 'n1'],
      ['secrets', 'x'],
      ['fileViews', pairId('s2', 'src/a.ts')],
    ])
    expect(reply.changes.map((c) => c.kind)).toEqual(['repos', 'sessions'])
  })

  it('refuses a malformed envelope', async () => {
    const { app, token } = await setup()
    expect((await request(app, 'POST', '/api/sync', { cursor: -1, changes: [] }, token)).status).toBe(400)
    expect((await request(app, 'POST', '/api/sync', { cursor: 0 }, token)).status).toBe(400)
  })

  it('pages the change feed', async () => {
    const { push } = await setup()
    const many = Array.from({ length: SYNC_PAGE_SIZE + 5 }, (_, i) => ({ ...view(10, true), id: pairId('s1', `f${i}`), data: { sessionId: 's1', path: `f${i}`, contentHash: 'h', viewed: true } }))
    await push(many.slice(0, 400))
    const first = await push(many.slice(400))
    expect(first.changes).toHaveLength(SYNC_PAGE_SIZE)
    expect(first.more).toBe(true)
    const second = await push([], first.newCursor)
    expect(second.changes).toHaveLength(5)
    expect(second.more).toBe(false)
  })

  it('lets server-side writes win and appear in the feed', async () => {
    const { push, db } = await setup()
    await push([repo(Date.now() + 60_000)])
    const written = writeRecord(db, ADMIN_USER_ID, 'repos', repo(0).id, { ...repo(0).data, name: 'from server' })
    expect(written.changedAt).toBeGreaterThan(Date.now())
    const reply = await push([], 1)
    expect(reply.changes.map((c) => c.data?.name)).toEqual(['from server'])
  })

  it('keeps each user\'s records, revs and cursor apart, even for the same ids', async () => {
    const { db, pushAs } = await setup()
    const alice = createUserSession(db, 'alice')
    const bob = createUserSession(db, 'bob')
    const asAlice = pushAs(alice.token)
    const asBob = pushAs(bob.token)

    expect((await asAlice([repo(10, 'alice repo'), view(10, true)])).newCursor).toBe(2)
    const bobs = await asBob([repo(5, 'bob repo')])
    expect(bobs.changes.map((c) => [c.rev, c.data?.name])).toEqual([[1, 'bob repo']])
    expect(bobs.newCursor).toBe(1)

    expect(readRecord(db, alice.user.id, 'repos', repo(0).id)?.data).toMatchObject({ name: 'alice repo' })
    expect(readRecord(db, bob.user.id, 'repos', repo(0).id)?.data).toMatchObject({ name: 'bob repo' })
    expect(readRecord(db, bob.user.id, 'fileViews', view(0, true).id)).toBeNull()

    expect((await asAlice([], 2)).changes).toEqual([])
    expect((await asBob([], 0)).changes.map((c) => c.data?.name)).toEqual(['bob repo'])
    await asBob([{ kind: 'repos', id: repo(0).id, changedAt: 50, deleted: true }])
    expect(readRecord(db, alice.user.id, 'repos', repo(0).id)?.deleted).toBe(false)
  })

  it('counts each user\'s rows and live bytes as records grow, shrink and are deleted', async () => {
    const { db, push } = await setup()
    const usage = () =>
      db.query<{ record_count: number; data_bytes: number }, [string]>('SELECT record_count, data_bytes FROM users WHERE id = ?').get(ADMIN_USER_ID)!
    const bytes = (change: WireChange) => Buffer.byteLength(JSON.stringify(change.data))

    await push([repo(10, 'short')])
    expect(usage()).toEqual({ record_count: 1, data_bytes: bytes(repo(10, 'short')) })
    await push([repo(11, 'a much longer name ✓')])
    expect(usage()).toEqual({ record_count: 1, data_bytes: bytes(repo(11, 'a much longer name ✓')) })
    await push([view(10, true), { kind: 'sessions', id: 'never-stored', changedAt: 10, deleted: true }])
    expect(usage()).toEqual({ record_count: 3, data_bytes: bytes(repo(11, 'a much longer name ✓')) + bytes(view(10, true)) })
    await push([{ kind: 'repos', id: repo(0).id, changedAt: 12, deleted: true }])
    expect(usage()).toEqual({ record_count: 3, data_bytes: bytes(view(10, true)) })
    await push([repo(9, 'stale')])
    expect(usage()).toEqual({ record_count: 3, data_bytes: bytes(view(10, true)) })
  })
})
