import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeDuckyDb } from '../../src/db/db'
import { INBOX_ID, type InboxItem, type Note, type Session } from '../../src/db/schema'
import { applyBadge, badgeApi, badgeCount, followBadge, openNoteCount, reviewRequestCount } from '../../src/pwa/badge'

const dbs: CodeDuckyDb[] = []
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.delete()
})

const openDb = (name: string) => {
  const db = new CodeDuckyDb(name)
  dbs.push(db)
  return db
}

const session = (id: string, status: Session['status']): Session => ({
  id,
  repoId: 'r1',
  branch: id,
  headSha: 'h',
  baseSha: 'b',
  baseSource: 'local',
  startedAt: 1,
  status,
})

const note = (id: string, sessionId: string, status: Note['status']): Note => ({
  id,
  sessionId,
  path: 'a.ts',
  anchor: { line: 1, side: 'new', text: 'x', before: [], after: [] },
  body: id,
  severity: 'issue',
  status,
  source: 'me',
  createdAt: 1,
  updatedAt: 1,
})

const item = (number: number, section: InboxItem['section']): InboxItem => ({
  repo: 'acme/web',
  number,
  title: `PR ${number}`,
  author: 'sam',
  url: `https://github.com/acme/web/pull/${number}`,
  updatedAt: '2026-10-01T00:00:00Z',
  section,
})

function fakeApi() {
  return { setAppBadge: vi.fn(async () => undefined), clearAppBadge: vi.fn(async () => undefined) }
}

async function seed(db: CodeDuckyDb) {
  await db.sessions.bulkPut([session('active', 'active'), session('old', 'archived')])
  await db.notes.bulkPut([
    note('n1', 'active', 'open'),
    note('n2', 'active', 'open'),
    note('n3', 'active', 'resolved'),
    note('n4', 'active', 'suggested'),
    note('n5', 'old', 'open'),
  ])
  await db.inbox.put({ id: INBOX_ID, fetchedAt: 1, items: [item(1, 'requested'), item(2, 'requested'), item(3, 'mine'), item(4, 'reviewed')] })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe('app badge', () => {
  it('counts open notes in active sessions only', async () => {
    const db = openDb('badge-notes')
    expect(await openNoteCount(db)).toBe(0)
    await seed(db)
    expect(await openNoteCount(db)).toBe(2)
    expect(await badgeCount(db, 'notes')).toBe(2)
  })

  it('counts review requests waiting in the inbox', async () => {
    const db = openDb('badge-requests')
    expect(await reviewRequestCount(db)).toBe(0)
    await seed(db)
    expect(await reviewRequestCount(db)).toBe(2)
    expect(await badgeCount(db, 'requests')).toBe(2)
    expect(await badgeCount(db, 'off')).toBe(0)
  })

  it('sets the count, and clears the badge at zero', async () => {
    const api = fakeApi()
    await applyBadge(api, 3)
    expect(api.setAppBadge).toHaveBeenCalledWith(3)
    await applyBadge(api, 0)
    expect(api.clearAppBadge).toHaveBeenCalledOnce()
  })

  it('needs both badging calls', () => {
    expect(badgeApi(undefined)).toBeNull()
    expect(badgeApi({ setAppBadge: async () => undefined })).toBeNull()
    expect(badgeApi(fakeApi())).not.toBeNull()
  })

  it('follows the data as it changes, and stops when asked', async () => {
    const db = openDb('badge-follow')
    await seed(db)
    const api = fakeApi()
    const stop = followBadge(db, 'notes', api)
    await settle()
    expect(api.setAppBadge).toHaveBeenLastCalledWith(2)

    await db.notes.put(note('n6', 'active', 'open'))
    await settle()
    expect(api.setAppBadge).toHaveBeenLastCalledWith(3)

    await db.notes.bulkDelete(['n1', 'n2', 'n6'])
    await settle()
    expect(api.clearAppBadge).toHaveBeenCalled()

    stop()
    const calls = api.setAppBadge.mock.calls.length
    await db.notes.put(note('n7', 'active', 'open'))
    await settle()
    expect(api.setAppBadge.mock.calls.length).toBe(calls)
  })

  it('clears the badge when switched off, and does nothing without the API', async () => {
    const db = openDb('badge-off')
    const api = fakeApi()
    followBadge(db, 'off', api)
    await settle()
    expect(api.clearAppBadge).toHaveBeenCalledOnce()
    expect(followBadge(db, 'notes', null)).toBeTypeOf('function')
  })
})
