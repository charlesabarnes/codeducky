import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { RubberduckDb } from '../../src/db/db'
import { MAX_SNAPSHOT_FILE_BYTES, pruneSnapshots, putSnapshot, readSnapshot, snapshotOids } from '../../src/db/reviewSnapshots'

const opened: RubberduckDb[] = []
const open = (name: string) => {
  const db = new RubberduckDb(`snapshots-${name}`)
  opened.push(db)
  return db
}
afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.delete()))
})

const bytes = (size: number, fill = 97) => new Uint8Array(size).fill(fill)
const DAY = 24 * 60 * 60 * 1000

describe('review snapshots', () => {
  it('stores content once per oid and refreshes its age on rewrite and read', async () => {
    const db = open('dedupe')
    await putSnapshot(db, 'a1', bytes(10), 1000)
    await putSnapshot(db, 'a1', bytes(10), 2000)
    expect(await db.reviewSnapshots.count()).toBe(1)
    expect((await db.reviewSnapshots.get('a1'))!.at).toBe(2000)
    expect(await readSnapshot(db, 'a1', 3000)).toEqual(bytes(10))
    expect((await db.reviewSnapshots.get('a1'))!.at).toBe(3000)
    expect(await readSnapshot(db, 'missing')).toBeNull()
    expect([...(await snapshotOids(db, ['a1', 'missing', 'a1']))]).toEqual(['a1'])
  })

  it('skips files over the size cap', async () => {
    const db = open('cap')
    expect(await putSnapshot(db, 'big', bytes(MAX_SNAPSHOT_FILE_BYTES + 1))).toBe(false)
    expect(await db.reviewSnapshots.count()).toBe(0)
  })

  it('never reaches the sync outbox', async () => {
    const db = open('local')
    await putSnapshot(db, 'a1', bytes(4))
    expect(await db.outbox.count()).toBe(0)
  })

  it('drops snapshots past the age limit', async () => {
    const db = open('age')
    const now = 100 * DAY
    await putSnapshot(db, 'old', bytes(5), now - 61 * DAY)
    await putSnapshot(db, 'fresh', bytes(5), now - DAY)
    expect(await pruneSnapshots(db, now)).toBe(1)
    expect(await db.reviewSnapshots.toCollection().primaryKeys()).toEqual(['fresh'])
  })

  it('evicts the least recently used until the total fits', async () => {
    const db = open('lru')
    const limits = { maxTotalBytes: 25 }
    await putSnapshot(db, 'a', bytes(10), 1, limits)
    await putSnapshot(db, 'b', bytes(10), 2, limits)
    await readSnapshot(db, 'a', 3) // a is now more recent than b
    await putSnapshot(db, 'c', bytes(10), 4, limits)
    expect((await db.reviewSnapshots.toCollection().primaryKeys()).sort()).toEqual(['a', 'c'])
  })
})
