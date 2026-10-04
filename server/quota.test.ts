import { afterEach, describe, expect, it } from 'bun:test'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { pairId, type SyncResponse, type WireChange } from '../shared/sync'
import { loadQuotas, getUsage, DEFAULT_QUOTAS, type Quotas } from './records/quota'
import { readRecord } from './records/store'
import { createUserSession, makeApp, mcpClient, request } from './testing'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

function setup(quotas: Quotas) {
  const made = makeApp({ quotas })
  cleanups.push(made.cleanup)
  const alice = createUserSession(made.db, 'alice')
  const push = async (changes: WireChange[], token = alice.token) => {
    const res = await request(made.app, 'POST', '/api/sync', { cursor: 0, changes }, token)
    expect(res.status).toBe(200)
    return ((await res.json()) as SyncResponse).rejected
  }
  return { ...made, alice, push, usage: (userId = alice.user.id) => getUsage(made.db, userId) }
}

const idOf = (path: string) => pairId('s1', path)

const view = (path: string, changedAt: number, hash = 'h'): WireChange => ({
  kind: 'fileViews',
  id: idOf(path),
  changedAt,
  deleted: false,
  data: { sessionId: 's1', path, contentHash: hash, viewed: true },
})

const tombstone = (path: string, changedAt: number): WireChange => ({ kind: 'fileViews', id: idOf(path), changedAt, deleted: true })
const refused = (path: string) => ({ kind: 'fileViews', id: idOf(path), error: 'quota_exceeded' })

const bytesOf = (change: WireChange) => Buffer.byteLength(JSON.stringify(change.data))

describe('quota: rows', () => {
  it('rejects new rows past the limit with quota_exceeded, and applies the rest', async () => {
    const { push, usage, db, alice } = setup({ records: 2, bytes: DEFAULT_QUOTAS.bytes })
    const rejected = await push([view('a', 1), view('b', 1), view('c', 1)])
    expect(rejected).toEqual([refused('c')])
    expect(readRecord(db, alice.user.id, 'fileViews', idOf('c'))).toBeNull()
    expect(usage().usage.records).toBe(2)
  })

  it('still updates existing rows at the limit', async () => {
    const { push, db, alice } = setup({ records: 1, bytes: DEFAULT_QUOTAS.bytes })
    await push([view('a', 1)])
    expect(await push([view('a', 2, 'newer')])).toEqual([])
    expect(readRecord(db, alice.user.id, 'fileViews', idOf('a'))?.data).toMatchObject({ contentHash: 'newer' })
  })

  it('always deletes stored records, and stores tombstones for new ids only while there is room', async () => {
    const { push, usage, db, alice } = setup({ records: 2, bytes: DEFAULT_QUOTAS.bytes })
    await push([view('a', 1)])
    expect(await push([tombstone('a', 2), tombstone('b', 2), tombstone('c', 2)])).toEqual([])
    expect(usage().usage).toEqual({ records: 2, bytes: 0 })
    expect(readRecord(db, alice.user.id, 'fileViews', idOf('b'))?.deleted).toBe(true)
    expect(readRecord(db, alice.user.id, 'fileViews', idOf('c'))).toBeNull()
  })
})

describe('quota: bytes', () => {
  it('rejects a write that grows usage past the limit', async () => {
    const first = view('a', 1)
    const { push, usage } = setup({ records: 100, bytes: bytesOf(first) + 10 })
    await push([first])
    expect(await push([view('b', 1)])).toEqual([refused('b')])
    expect(await push([view('a', 2, 'a much longer content hash')])).toEqual([refused('a')])
    expect(usage().usage.bytes).toBe(bytesOf(first))
  })

  it('lets a user over quota shrink and delete', async () => {
    const big = view('a', 1, 'x'.repeat(500))
    const { push, usage, db, alice } = setup({ records: 100, bytes: DEFAULT_QUOTAS.bytes })
    await push([big, view('b', 1)])
    db.query('UPDATE users SET quota_bytes = 10 WHERE id = ?').run(alice.user.id)

    expect(await push([view('a', 2, 'small')])).toEqual([])
    expect(await push([tombstone('b', 2)])).toEqual([])
    expect(usage().usage.bytes).toBe(bytesOf(view('a', 2, 'small')))
    expect(await push([view('b', 3)])).toEqual([refused('b')])
  })
})

describe('quota: limits', () => {
  it('prefers the user override to the configured default, per user', async () => {
    const { push, db, alice } = setup({ records: 1, bytes: DEFAULT_QUOTAS.bytes })
    const bob = createUserSession(db, 'bob')
    db.query('UPDATE users SET quota_records = 3 WHERE id = ?').run(alice.user.id)

    expect(await push([view('a', 1), view('b', 1), view('c', 1)])).toEqual([])
    expect(await push([view('a', 1), view('b', 1)], bob.token)).toEqual([refused('b')])
    expect(getUsage(db, alice.user.id).quota.records).toBe(3)
    expect(getUsage(db, bob.user.id).quota.records).toBe(1)
  })

  it('reads defaults from the environment', () => {
    expect(loadQuotas({})).toEqual(DEFAULT_QUOTAS)
    expect(loadQuotas({ CODEDUCKY_QUOTA_RECORDS: '500', CODEDUCKY_QUOTA_BYTES: '1048576' })).toEqual({ records: 500, bytes: 1048576 })
    expect(() => loadQuotas({ CODEDUCKY_QUOTA_RECORDS: '-1' })).toThrow('CODEDUCKY_QUOTA_RECORDS')
    expect(() => loadQuotas({ CODEDUCKY_QUOTA_BYTES: '1.5' })).toThrow('CODEDUCKY_QUOTA_BYTES')
  })
})

describe('quota: MCP', () => {
  it('turns a quota failure into a tool error', async () => {
    const { push, app, tokens, alice } = setup({ records: 2, bytes: DEFAULT_QUOTAS.bytes })
    const repo = 'gh:alice/app'
    await push([
      { kind: 'repos', id: repo, changedAt: 1, deleted: false, data: { owner: 'alice', name: 'app', folderName: 'app', baseBranch: 'main', lastOpenedAt: 1, checklistIds: [] } },
      { kind: 'sessions', id: 's1', changedAt: 1, deleted: false, data: { repoId: repo, branch: 'feat', headSha: 'h', baseSha: 'b', baseSource: 'local', startedAt: 1, status: 'active' } },
    ])
    const { token } = tokens.issue({ userId: alice.user.id, name: 'Claude', kind: 'api' })
    const client = await mcpClient(app, token)
    const result = (await client.callTool({ name: 'add_note', arguments: { session: 's1', path: 'a.ts', line: 1, body: 'Hi' } })) as CallToolResult
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('Quota exceeded') })
    await client.close()
  })
})
