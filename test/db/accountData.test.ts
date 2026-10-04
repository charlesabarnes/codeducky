import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { ACCOUNT_TABLES, DEVICE_TABLES, wipeAccountData } from '../../src/db/accountData'
import { CodeDuckyDb } from '../../src/db/db'
import { addNote } from '../../src/db/notes'
import { saveOpenedRepo } from '../../src/db/repos'
import { loadSettings, saveSettings } from '../../src/db/settings'
import { META_ACCOUNT, setMeta } from '../../src/sync/meta'

const opened: CodeDuckyDb[] = []
const open = (name: string) => {
  const db = new CodeDuckyDb(name)
  opened.push(db)
  return db
}
afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.delete()))
})

const anchor = { line: 1, side: 'new' as const, text: 'x', before: [], after: [] }
const folder = { kind: 'directory', name: 'codeducky' } as unknown as FileSystemDirectoryHandle

describe('account data', () => {
  it('classifies every table as account or device data, exactly once', async () => {
    const db = open('classify')
    await db.open()
    const classified: string[] = [...ACCOUNT_TABLES, ...DEVICE_TABLES]
    expect(new Set(classified).size).toBe(classified.length)
    expect(classified.toSorted()).toEqual(db.tables.map((table) => table.name).toSorted())
  })

  it('wipes every account table, keeps appearance and drops the GitHub token, without queueing uploads', async () => {
    const db = open('wipe')
    await saveSettings(db, { githubPat: 'ghp_secret', palette: 'dusk', theme: 'light' })
    const repoId = await saveOpenedRepo(db, folder, { owner: 'o', name: 'r', defaultBase: 'main' })
    await addNote(db, { sessionId: 's', path: 'a.ts', anchor, body: 'private', severity: 'nit' })
    await db.githubBlobs.put({ oid: 'abc', bytes: new Uint8Array([1]), at: 1 })
    await db.reviewSnapshots.put({ oid: 'def', bytes: new Uint8Array([1]), size: 1, at: 1 })
    await db.rejected.put({ key: 'notes:x', kind: 'notes', id: 'x', changedAt: 1, deleted: false, error: 'no', at: 1 })
    await setMeta(db, META_ACCOUNT, { id: 'alice', login: 'alice' })
    expect(await db.repoHandles.get(repoId)).toBeDefined()
    expect(await db.outbox.count()).toBeGreaterThan(0)

    await wipeAccountData(db)

    for (const name of ACCOUNT_TABLES) expect(await db.table(name).count(), name).toBe(0)
    expect(await loadSettings(db)).toMatchObject({ githubPat: '', palette: 'dusk', theme: 'light' })
  })
})
