import { SYNC_KINDS } from '../../shared/sync'
import { remoteTransaction } from '../sync/engine'
import type { CodeDuckyDb } from './db'

/** Tables holding one account's data: review records, sync state and caches of repo content. */
export const ACCOUNT_TABLES = [...SYNC_KINDS, 'outbox', 'rejected', 'syncMeta', 'repoHandles', 'githubBlobs', 'reviewSnapshots', 'patches'] as const

/** Tables that belong to the browser rather than an account; `settings` still loses the GitHub token on a wipe. */
export const DEVICE_TABLES = ['settings'] as const

/**
 * Removes every account's data from this browser in one transaction. It is marked remote, so the
 * deletes never reach the outbox and nothing uploads to the next account. Appearance stays.
 */
export function wipeAccountData(db: CodeDuckyDb): Promise<void> {
  const tables = [...ACCOUNT_TABLES, ...DEVICE_TABLES].map((name) => db.table(name))
  return remoteTransaction(
    db,
    async () => {
      await Promise.all(ACCOUNT_TABLES.map((name) => db.table(name).clear()))
      await db.settings.update('app', { githubPat: '' })
    },
    tables,
  )
}
