import type { SkelbertDb } from '../db/db'
import type { GitHubClient } from './client'
import type { RepoRef } from './types'

/** Blobs kept on this device; the oldest go first. */
export const MAX_CACHED_BLOBS = 2000
const MAX_CACHED_BYTES = 5 * 1024 * 1024

const MAX_MEMORY_BLOBS = 300
const memory = new Map<string, Promise<Uint8Array>>()

async function prune(db: SkelbertDb): Promise<void> {
  const extra = (await db.githubBlobs.count()) - MAX_CACHED_BLOBS
  if (extra > 0) await db.githubBlobs.orderBy('at').limit(extra).delete()
}

/**
 * Loads blobs by id: from memory, then IndexedDB, then the GitHub API. A blob id names its
 * content, so cached entries never go stale. Very large blobs are kept in memory only.
 */
export function cachedBlobLoader(db: SkelbertDb, gh: GitHubClient, ref: RepoRef) {
  return (oid: string): Promise<Uint8Array> => {
    let pending = memory.get(oid)
    if (!pending) {
      pending = (async () => {
        const stored = await db.githubBlobs.get(oid).catch(() => undefined)
        if (stored) return stored.bytes
        const bytes = await gh.blob(ref, oid)
        if (bytes.byteLength <= MAX_CACHED_BYTES) {
          await db.githubBlobs
            .put({ oid, bytes, at: Date.now() })
            .then(() => prune(db))
            .catch((error: unknown) => console.warn('Could not cache a blob', error))
        }
        return bytes
      })()
      memory.set(oid, pending)
      if (memory.size > MAX_MEMORY_BLOBS) memory.delete(memory.keys().next().value!)
      pending.catch(() => memory.delete(oid))
    }
    return pending
  }
}
