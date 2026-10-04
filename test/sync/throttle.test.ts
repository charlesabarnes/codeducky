import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeDuckyDb } from '../../src/db/db'
import { parseRetryAfter } from '../../src/sync/api'
import { SyncController } from '../../src/sync/controller'
import { META_AUTH, setMeta } from '../../src/sync/meta'
import { listRejected, rejectionMessage } from '../../src/sync/rejected'

const opened: { db: CodeDuckyDb; controller?: SyncController }[] = []
afterEach(async () => {
  for (const { db, controller } of opened.splice(0)) {
    controller?.dispose()
    await db.delete()
  }
})

describe('parseRetryAfter', () => {
  it('reads delay seconds and HTTP dates', () => {
    expect(parseRetryAfter('7')).toBe(7000)
    expect(parseRetryAfter(new Date(61_000).toUTCString(), 1_000)).toBe(60_000)
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('soon')).toBeNull()
    expect(parseRetryAfter('-3')).toBeNull()
    expect(parseRetryAfter(new Date(1_000).toUTCString(), 61_000)).toBeNull()
    expect(parseRetryAfter('86400')).toBeNull()
  })
})

describe('sync on 429', () => {
  it('retries after Retry-After rather than the default delay', async () => {
    const db = new CodeDuckyDb('throttle')
    await setMeta(db, META_AUTH, { token: 't', tokenId: 'id', name: 'Browser' })
    let calls = 0
    const fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/auth/session')) return new Response(JSON.stringify({}), { status: 503 })
      calls++
      if (calls === 1) return new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers: { 'Retry-After': '1' } })
      return new Response(JSON.stringify({ changes: [], newCursor: 0, more: false, rejected: [] }))
    }) as typeof globalThis.fetch
    const controller = new SyncController(db, { fetch, listenToBrowser: false, retryMs: 3_600_000, intervalMs: 3_600_000 })
    opened.push({ db, controller })
    await controller.start()
    await controller.sync()
    expect(calls).toBe(1)
    await vi.waitFor(() => expect(calls).toBe(2), { timeout: 3000 })
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('idle'))
  })
})

describe('refused changes', () => {
  it('explains quota_exceeded and shows other errors as sent', async () => {
    expect(rejectionMessage('quota_exceeded')).toContain('storage quota')
    expect(rejectionMessage('record is too large')).toBe('record is too large')

    const db = new CodeDuckyDb('refused')
    opened.push({ db })
    await db.rejected.put({ key: 'notes:n1', kind: 'notes', id: 'n1', changedAt: 1, deleted: false, error: 'quota_exceeded', at: 1 })
    expect(await listRejected(db)).toMatchObject([{ id: 'n1', error: rejectionMessage('quota_exceeded') }])
  })
})
