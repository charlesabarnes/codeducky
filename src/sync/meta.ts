import type { CodeDuckyDb } from '../db/db'

export const META_CURSOR = 'cursor'
export const META_LAST_SYNCED_AT = 'lastSyncedAt'
export const META_AUTH = 'auth'
/** The account this browser's data belongs to; kept on sign-out so another account cannot pick the data up. */
export const META_ACCOUNT = 'account'

export interface SessionUser {
  id: string
  login: string
  name: string | null
  avatarUrl: string | null
  role: 'user' | 'admin'
}

export interface StoredAuth {
  token: string
  tokenId: string
  name: string
  /** Missing on sign-ins from before accounts; filled in by the next session refresh. */
  user?: SessionUser
}

export interface BoundAccount {
  id: string
  login: string
}

export async function getMeta<T>(db: CodeDuckyDb, key: string): Promise<T | undefined> {
  return (await db.syncMeta.get(key))?.value as T | undefined
}

export async function setMeta(db: CodeDuckyDb, key: string, value: unknown): Promise<void> {
  await db.syncMeta.put({ key, value })
}
