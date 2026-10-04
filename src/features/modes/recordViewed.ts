import { db } from '../../db/db'
import { markViewed, recordReviewHead } from '../../db/fileViews'
import { MAX_SNAPSHOT_FILE_BYTES, putSnapshot } from '../../db/reviewSnapshots'
import { gitService } from '../../git/client'
import type { FileChange } from '../../git/types'

/**
 * Marks a branch file viewed or not. The small synced record is written first, so the checkbox never waits; for a
 * local session the git worker then reads HEAD and, if the content is not a git object yet (uncommitted), reads and
 * hashes it off the main thread to keep a local snapshot for "since last look". Pull requests pass their head.
 */
export async function recordViewed(sessionId: string, change: FileChange, viewed: boolean, prHead: string | null): Promise<void> {
  await markViewed(db, { sessionId, change, viewed, head: prHead ?? undefined })
  if (!viewed || prHead) return
  const snapshot = await gitService().reviewSnapshot(change.path, change.newOid ?? '', MAX_SNAPSHOT_FILE_BYTES)
  if (snapshot.bytes && change.newOid) await putSnapshot(db, change.newOid, snapshot.bytes)
  await recordReviewHead(db, sessionId, change.path, snapshot.head)
}
