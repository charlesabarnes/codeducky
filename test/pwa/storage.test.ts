import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeDuckyDb } from '../../src/db/db'
import { formatBytes, readStorageStatus, requestPersistence, startStoragePersistence, type StorageApi } from '../../src/pwa/storage'

function fakeStorage({ persisted = false, grants = true } = {}) {
  let state = persisted
  const storage = {
    persisted: vi.fn(async () => state),
    persist: vi.fn(async () => {
      state = grants
      return grants
    }),
    estimate: vi.fn(async () => ({ usage: 5 * 1024 * 1024, quota: 2 * 1024 ** 3 })),
  }
  return storage satisfies StorageApi
}

function fakeEvents() {
  const listeners = new Map<string, () => void>()
  return {
    addEventListener: vi.fn((type: string, listener: () => void) => listeners.set(type, listener)),
    removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    fire: (type: string) => listeners.get(type)?.(),
    has: (type: string) => listeners.has(type),
  }
}

const dbs: CodeDuckyDb[] = []
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.delete()
})

const openDb = (name: string) => {
  const db = new CodeDuckyDb(name)
  dbs.push(db)
  return db
}

const addRepo = (db: CodeDuckyDb) =>
  db.repos.add({ id: 'gh:a/b', owner: 'a', name: 'b', folderName: 'b', baseBranch: 'main', checklistIds: [], lastOpenedAt: 1 })

describe('storage status', () => {
  it('reads persistence and the estimate', async () => {
    expect(await readStorageStatus(fakeStorage({ persisted: true }))).toEqual({
      supported: true,
      persisted: true,
      usage: 5 * 1024 * 1024,
      quota: 2 * 1024 ** 3,
    })
  })

  it('reports an unsupported browser', async () => {
    expect(await readStorageStatus(undefined)).toEqual({ supported: false, persisted: false, usage: null, quota: null })
    expect(await requestPersistence(undefined)).toBe(false)
  })

  it('keeps the status when the estimate fails', async () => {
    const storage = fakeStorage()
    storage.estimate.mockRejectedValue(new Error('nope'))
    expect(await readStorageStatus(storage)).toMatchObject({ supported: true, usage: null, quota: null })
  })

  it('only asks when not already persisted', async () => {
    const already = fakeStorage({ persisted: true })
    expect(await requestPersistence(already)).toBe(true)
    expect(already.persist).not.toHaveBeenCalled()
    const refused = fakeStorage({ grants: false })
    expect(await requestPersistence(refused)).toBe(false)
    expect(refused.persist).toHaveBeenCalledOnce()
  })

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(20 * 1024 ** 3)).toBe('20 GB')
  })
})

describe('startStoragePersistence', () => {
  it('waits for local data, then asks once', async () => {
    const db = openDb('persist-data')
    const storage = fakeStorage()
    const events = fakeEvents()
    startStoragePersistence(db, { storage, installed: () => false, events })
    await new Promise((r) => setTimeout(r, 50))
    expect(storage.persist).not.toHaveBeenCalled()
    await addRepo(db)
    await vi.waitFor(() => expect(storage.persist).toHaveBeenCalledOnce())
    expect(events.has('appinstalled')).toBe(false)
    await db.sessions.add({ id: 's' } as never)
    await new Promise((r) => setTimeout(r, 50))
    expect(storage.persist).toHaveBeenCalledOnce()
  })

  it('asks straight away when installed', async () => {
    const storage = fakeStorage()
    startStoragePersistence(openDb('persist-installed'), { storage, installed: () => true, events: fakeEvents() })
    await vi.waitFor(() => expect(storage.persist).toHaveBeenCalledOnce())
  })

  it('asks when the app gets installed', async () => {
    const storage = fakeStorage()
    const events = fakeEvents()
    startStoragePersistence(openDb('persist-appinstalled'), { storage, installed: () => false, events })
    events.fire('appinstalled')
    await vi.waitFor(() => expect(storage.persist).toHaveBeenCalledOnce())
  })

  it('does not ask again when already persisted', async () => {
    const db = openDb('persist-already')
    await addRepo(db)
    const storage = fakeStorage({ persisted: true })
    startStoragePersistence(db, { storage, installed: () => false, events: fakeEvents() })
    await vi.waitFor(() => expect(storage.persisted).toHaveBeenCalled())
    expect(storage.persist).not.toHaveBeenCalled()
  })
})
