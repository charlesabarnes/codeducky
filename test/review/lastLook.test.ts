import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { SkelbertDb } from '../../src/db/db'
import { loadLastLooks, markViewed, recordArchivedReview, recordReviewHead, recordReviewedFiles } from '../../src/db/fileViews'
import type { FileView } from '../../src/db/schema'
import { startNewSession, startOrResumeSession } from '../../src/db/sessions'
import type { FileChange } from '../../src/git/types'
import { ABSENT, classifySince, countSince, interdiff, lastLooks, latestReview } from '../../src/review/lastLook'

const view = (path: string, extra: Partial<FileView>): FileView => ({ sessionId: 's', path, contentHash: 'b:n', viewed: true, ...extra })
const change = (path: string, oldOid: string | null, newOid: string | null): FileChange => ({
  path,
  status: !oldOid ? 'added' : !newOid ? 'deleted' : 'modified',
  oldOid,
  newOid,
})

describe('last looks', () => {
  it('keeps the latest look per path, across sessions, and reads legacy views from their content hash', () => {
    const looks = lastLooks([
      view('a.ts', { reviewedOid: 'a1', reviewedAt: 1, reviewedHead: 'h1' }),
      view('a.ts', { sessionId: 't', reviewedOid: 'a2', reviewedAt: 5, reviewedHead: 'h2' }),
      view('legacy.ts', { contentHash: 'base:l1', changedAt: 3 }),
      view('unviewed-legacy.ts', { contentHash: 'base:u1', viewed: false }),
      view('unmarked.ts', { viewed: false, reviewedOid: 'm1', reviewedAt: 2 }),
    ])
    expect(looks.get('a.ts')).toEqual({ path: 'a.ts', oid: 'a2', head: 'h2', at: 5 })
    expect(looks.get('legacy.ts')?.oid).toBe('l1')
    expect(looks.has('unviewed-legacy.ts')).toBe(false)
    expect(looks.get('unmarked.ts')?.oid).toBe('m1')
    expect(latestReview([{ lastReview: { headSha: 'x', at: 1 } }, {}, { lastReview: { headSha: 'y', at: 9 } }])).toEqual({ headSha: 'y', at: 9 })
  })

  it('classifies files as new, changed, unchanged or missing', () => {
    const files = [
      change('same.ts', 'b1', 'n1'),
      change('edited.ts', 'b2', 'n2'),
      change('never.ts', 'b3', 'n3'),
      change('gone-reviewed.ts', 'b4', 'n4'),
      change('deleted-since.ts', 'b5', null),
      change('was-deleted.ts', null, 'n6'),
    ]
    const looks = lastLooks([
      view('same.ts', { reviewedOid: 'n1', reviewedAt: 1 }),
      view('edited.ts', { reviewedOid: 'r2', reviewedAt: 1 }),
      view('gone-reviewed.ts', { reviewedOid: 'lost', reviewedAt: 1 }),
      view('deleted-since.ts', { reviewedOid: 'r5', reviewedAt: 1 }),
      view('was-deleted.ts', { reviewedOid: ABSENT, reviewedAt: 1 }),
    ])
    const entries = classifySince(files, looks, (oid) => oid !== 'lost')
    expect(entries.map((entry) => [entry.change.path, entry.kind])).toEqual([
      ['same.ts', 'unchanged'],
      ['edited.ts', 'changed'],
      ['never.ts', 'new'],
      ['gone-reviewed.ts', 'missing'],
      ['deleted-since.ts', 'changed'],
      ['was-deleted.ts', 'changed'],
    ])
    expect(entries[1]!.change).toEqual({ path: 'edited.ts', status: 'modified', oldOid: 'r2', newOid: 'n2' })
    expect(entries[2]!.change).toBe(files[2])
    expect(entries[4]!.change).toEqual({ path: 'deleted-since.ts', status: 'deleted', oldOid: 'r5', newOid: null })
    expect(interdiff(files[5]!, ABSENT)).toEqual({ path: 'was-deleted.ts', status: 'added', oldOid: null, newOid: 'n6' })
    expect(countSince(entries)).toEqual({ changed: 3, unchanged: 1, fresh: 1, missing: 1 })
  })
})

const opened: SkelbertDb[] = []
const open = (name: string) => {
  const db = new SkelbertDb(`lastlook-${name}`)
  opened.push(db)
  return db
}
afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.delete()))
})

describe('recording what you reviewed', () => {
  const start = { repoId: 'r1', branch: 'feature', headSha: 'h1', baseSha: 'b1' }

  it('records the reviewed oid on view, keeps it when unmarked, and syncs only hashes', async () => {
    const db = open('mark')
    const sessionId = await startOrResumeSession(db, start)
    await markViewed(db, { sessionId, change: change('a.ts', 'b', 'n1'), viewed: true }, 10)
    await recordReviewHead(db, sessionId, 'a.ts', 'h1', 11)
    expect(await db.fileViews.get([sessionId, 'a.ts'])).toMatchObject({ viewed: true, contentHash: 'b:n1', reviewedOid: 'n1', reviewedHead: 'h1', reviewedAt: 10 })
    expect((await db.sessions.get(sessionId))!.lastReview).toEqual({ headSha: 'h1', at: 11 })

    await markViewed(db, { sessionId, change: change('a.ts', 'b', 'n2'), viewed: false }, 20)
    expect(await db.fileViews.get([sessionId, 'a.ts'])).toMatchObject({ viewed: false, contentHash: 'b:n2', reviewedOid: 'n1', reviewedAt: 10 })
    const outbox = await db.outbox.toArray()
    expect(outbox.map((entry) => entry.kind).sort()).toContain('fileViews')
  })

  it('records a pull request head straight away, and every file at submit', async () => {
    const db = open('pr')
    const sessionId = await startOrResumeSession(db, start)
    await markViewed(db, { sessionId, change: change('a.ts', 'b', 'n1'), viewed: true, head: 'pr1' }, 5)
    expect((await db.sessions.get(sessionId))!.lastReview).toEqual({ headSha: 'pr1', at: 5 })
    await recordReviewedFiles(db, sessionId, 'pr2', [change('a.ts', 'b', 'n1'), change('b.ts', null, 'x1')], 9)
    expect(await db.fileViews.get([sessionId, 'a.ts'])).toMatchObject({ viewed: true, reviewedHead: 'pr2', reviewedOid: 'n1' })
    expect(await db.fileViews.get([sessionId, 'b.ts'])).toMatchObject({ viewed: false, reviewedHead: 'pr2', reviewedOid: 'x1' })
    expect((await db.sessions.get(sessionId))!.lastReview).toEqual({ headSha: 'pr2', at: 9 })
  })

  it('finds the last look in an archived session of the same branch', async () => {
    const db = open('archive')
    const first = await startOrResumeSession(db, start)
    await db.fileViews.put({ sessionId: first, path: 'a.ts', contentHash: 'b:n1', viewed: true })
    const second = await startNewSession(db, { ...start, headSha: 'h2' })
    expect((await db.sessions.get(first))!).toMatchObject({ status: 'archived', lastReview: { headSha: 'h1' } })
    const sessions = await db.sessions.where({ repoId: 'r1' }).toArray()
    const data = await loadLastLooks(db, sessions)
    expect(data.looks.get('a.ts')?.oid).toBe('n1')
    expect(data.review?.headSha).toBe('h1')
    // An archived session with nothing viewed records no review.
    await recordArchivedReview(db, (await db.sessions.get(second))!)
    expect((await db.sessions.get(second))!.lastReview).toBeUndefined()
  })
})
