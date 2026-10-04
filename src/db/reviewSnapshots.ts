import type { RubberduckDb } from './db'

/** Files bigger than this are not snapshotted; the diff viewer would not show them inline anyway. */
export const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024
/** All snapshots together stay under this; the least recently used go first. */
export const MAX_SNAPSHOT_TOTAL_BYTES = 50 * 1024 * 1024
/** Snapshots not written or read for this long are dropped. */
export const MAX_SNAPSHOT_AGE_MS = 60 * 24 * 60 * 60 * 1000

export interface SnapshotLimits {
  maxTotalBytes?: number
  maxAgeMs?: number
}

/**
 * Stores reviewed content under its blob oid. The same content is stored once (re-reviewing it only refreshes its
 * age). Returns false when the file is over the size cap.
 */
export async function putSnapshot(db: RubberduckDb, oid: string, bytes: Uint8Array, now = Date.now(), limits: SnapshotLimits = {}): Promise<boolean> {
  if (bytes.byteLength > MAX_SNAPSHOT_FILE_BYTES) return false
  await db.transaction('rw', db.reviewSnapshots, async () => {
    const existing = await db.reviewSnapshots.where('oid').equals(oid).primaryKeys()
    if (existing.length) await db.reviewSnapshots.update(oid, { at: now })
    else await db.reviewSnapshots.add({ oid, bytes, size: bytes.byteLength, at: now })
  })
  await pruneSnapshots(db, now, limits)
  return true
}

/** The snapshot's bytes, marking it as recently used; null when this device has none. */
export async function readSnapshot(db: RubberduckDb, oid: string, now = Date.now()): Promise<Uint8Array | null> {
  const snapshot = await db.reviewSnapshots.get(oid)
  if (!snapshot) return null
  await db.reviewSnapshots.update(oid, { at: now }).catch(() => undefined)
  return snapshot.bytes
}

/** Which of the oids have a snapshot on this device. Reads keys only. */
export async function snapshotOids(db: RubberduckDb, oids: readonly string[]): Promise<Set<string>> {
  if (oids.length === 0) return new Set()
  return new Set(await db.reviewSnapshots.where('oid').anyOf([...new Set(oids)]).primaryKeys())
}

/**
 * Drops snapshots older than the age limit, then the least recently used until the total fits the size cap.
 * Walks the [at+size] index with a key cursor, so no content is loaded.
 */
export async function pruneSnapshots(db: RubberduckDb, now = Date.now(), limits: SnapshotLimits = {}): Promise<number> {
  const maxTotal = limits.maxTotalBytes ?? MAX_SNAPSHOT_TOTAL_BYTES
  const maxAge = limits.maxAgeMs ?? MAX_SNAPSHOT_AGE_MS
  return db.transaction('rw', db.reviewSnapshots, async () => {
    const entries: { oid: string; at: number; size: number }[] = []
    await db.reviewSnapshots.orderBy('[at+size]').eachKey((key, cursor) => {
      const [at, size] = key as [number, number]
      entries.push({ oid: cursor.primaryKey as string, at, size })
    })
    let total = entries.reduce((sum, entry) => sum + entry.size, 0)
    const doomed: string[] = []
    for (const entry of entries) {
      if (now - entry.at <= maxAge && total <= maxTotal) break
      doomed.push(entry.oid)
      total -= entry.size
    }
    if (doomed.length) await db.reviewSnapshots.bulkDelete(doomed)
    return doomed.length
  })
}
