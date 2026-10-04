import type { RubberduckDb } from '../db/db'

export const META_CURSOR = 'cursor'
export const META_LAST_SYNCED_AT = 'lastSyncedAt'
export const META_AUTH = 'auth'

export interface StoredAuth {
  token: string
  tokenId: string
  name: string
}

export async function getMeta<T>(db: RubberduckDb, key: string): Promise<T | undefined> {
  return (await db.syncMeta.get(key))?.value as T | undefined
}

export async function setMeta(db: RubberduckDb, key: string, value: unknown): Promise<void> {
  await db.syncMeta.put({ key, value })
}
