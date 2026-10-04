import { liveQuery } from 'dexie'
import type { CodeDuckyDb } from '../db/db'
import { isInstalled } from './install'

export type StorageApi = Pick<StorageManager, 'persist' | 'persisted' | 'estimate'>

export interface StorageStatus {
  /** False when the browser has no StorageManager persistence API. */
  supported: boolean
  persisted: boolean
  usage: number | null
  quota: number | null
}

const browserStorage = (): StorageApi | undefined => (typeof navigator === 'undefined' ? undefined : navigator.storage)

const supports = (storage: StorageApi | undefined): storage is StorageApi =>
  typeof storage?.persist === 'function' && typeof storage.persisted === 'function'

export async function readStorageStatus(storage = browserStorage()): Promise<StorageStatus> {
  if (!supports(storage)) return { supported: false, persisted: false, usage: null, quota: null }
  const [persisted, estimate] = await Promise.all([
    storage.persisted(),
    typeof storage.estimate === 'function' ? storage.estimate().catch(() => null) : null,
  ])
  return { supported: true, persisted, usage: estimate?.usage ?? null, quota: estimate?.quota ?? null }
}

/** Asks the browser not to evict this origin's data; true when it is (or already was) persisted. */
export async function requestPersistence(storage = browserStorage()): Promise<boolean> {
  if (!supports(storage)) return false
  return (await storage.persisted()) || storage.persist()
}

interface PersistenceDeps {
  storage?: StorageApi
  installed?: () => boolean
  /** Window events; the app asks again once it is installed. */
  events?: Pick<Window, 'addEventListener' | 'removeEventListener'>
}

/**
 * Requests persistent storage once the app holds something worth keeping: a repo or a session,
 * or as soon as it runs installed. Returns a function that stops watching.
 */
export function startStoragePersistence(db: CodeDuckyDb, { storage = browserStorage(), installed = isInstalled, events = globalThis.window }: PersistenceDeps = {}) {
  if (!supports(storage)) return () => undefined
  let requested = false
  const request = () => {
    if (requested) return
    requested = true
    stop()
    requestPersistence(storage).catch((error: unknown) => console.warn('Could not request persistent storage', error))
  }
  const subscription = liveQuery(async () => (await db.repos.count()) + (await db.sessions.count())).subscribe({
    next: (count) => {
      if (count > 0) request()
    },
    error: (error: unknown) => console.warn('Could not count local data', error),
  })
  events?.addEventListener('appinstalled', request)
  function stop() {
    subscription.unsubscribe()
    events?.removeEventListener('appinstalled', request)
  }
  if (installed()) request()
  return stop
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`
}
