import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { SkelbertDb } from '../../src/db/db'
import { activePrSession, openPrSession } from '../../src/db/prSessions'
import { activeSession, startOrResumeSession } from '../../src/db/sessions'
import type { PrSnapshot } from '../../src/github/prDiff'
import type { PullDetail } from '../../src/github/types'

const dbs: SkelbertDb[] = []
afterEach(async () => {
  await Promise.all(dbs.splice(0).map((db) => db.delete()))
})
const fresh = () => {
  const db = new SkelbertDb(`pr-sessions-${Math.random()}`)
  dbs.push(db)
  return db
}

const snapshot = (headSha: string, mergeBaseSha = 'm1'): PrSnapshot => ({
  ref: { owner: 'Acme', name: 'API' },
  pull: { number: 7, title: 'Retry webhooks', htmlUrl: 'https://github.com/Acme/API/pull/7', headSha, headRef: 'feature/retry', baseRef: 'main', author: 'octo' } as PullDetail,
  mergeBaseSha,
  files: [],
})
const anchor = { line: 1, side: 'new' as const, text: 'x', before: [], after: [] }

describe('pull request sessions', () => {
  it('creates a gh: repo without a folder and a github-pr session', async () => {
    const db = fresh()
    const id = await openPrSession(db, snapshot('h1'), 1000)
    expect(await db.repos.get('gh:acme/api')).toMatchObject({ owner: 'Acme', name: 'API', folderName: '', baseBranch: 'main' })
    expect(await db.sessions.get(id)).toMatchObject({
      repoId: 'gh:acme/api',
      branch: 'feature/retry',
      headSha: 'h1',
      baseSha: 'm1',
      source: 'github-pr',
      baseSource: 'github',
      status: 'active',
      pr: { owner: 'Acme', name: 'API', number: 7, title: 'Retry webhooks', author: 'octo', baseRef: 'main' },
    })
    expect((await activePrSession(db, 'acme', 'api', 7))?.id).toBe(id)
  })

  it('resumes the active session and moves it to the new head', async () => {
    const db = fresh()
    const first = await openPrSession(db, snapshot('h1'))
    expect(await openPrSession(db, snapshot('h1'))).toBe(first)
    expect(await openPrSession(db, snapshot('h2', 'm2'))).toBe(first)
    expect(await db.sessions.get(first)).toMatchObject({ headSha: 'h2', baseSha: 'm2' })
    expect(await db.sessions.count()).toBe(1)
  })

  it('starts a new session after a submitted review, carrying only unsent open notes', async () => {
    const db = fresh()
    const first = await openPrSession(db, snapshot('h1'))
    const note = { sessionId: first, path: 'a.ts', anchor, body: 'b', severity: 'issue' as const, source: 'me' as const, createdAt: 1, updatedAt: 1 }
    await db.notes.bulkAdd([
      { ...note, id: 'sent', status: 'open', github: { reviewId: 3 } },
      { ...note, id: 'unsent', status: 'open' },
      { ...note, id: 'done', status: 'resolved' },
    ])
    await db.sessions.update(first, { status: 'archived', review: { state: 'COMMENTED', at: 5 } })
    const second = await openPrSession(db, snapshot('h3'))
    expect(second).not.toBe(first)
    const carried = await db.notes.where({ sessionId: second }).toArray()
    expect(carried.map((n) => n.carriedFrom)).toEqual(['unsent'])
  })

  it('keeps local sessions of the same branch separate', async () => {
    const db = fresh()
    const prId = await openPrSession(db, snapshot('h1'))
    expect(await activeSession(db, 'gh:acme/api', 'feature/retry')).toBeUndefined()
    const localId = await startOrResumeSession(db, { repoId: 'gh:acme/api', branch: 'feature/retry', headSha: 'L', baseSha: 'B' })
    expect(localId).not.toBe(prId)
    expect((await db.sessions.get(prId))!.status).toBe('active')
  })
})
