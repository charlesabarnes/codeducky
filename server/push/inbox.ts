import type { Database } from 'bun:sqlite'
import type { WireChange } from '../../shared/sync'
import type { InboxRecord } from '../mcp/records'
import { getRecord } from '../records/store'
import { requestsMessage } from './messages'
import type { PushSender } from './sender'

type InboxItem = InboxRecord['items'][number]

const requested = (inbox: InboxRecord) => inbox.items.filter((item) => item.section === 'requested')

/**
 * Review requests a synced inbox adds: items in the requested section whose URL was not requested in
 * the stored inbox before the sync. Without an earlier inbox (a first fetch, or a fresh account) nothing
 * is new, as in the PWA's own watcher, so signing in on a new device does not announce the whole inbox.
 */
export function newReviewRequests(before: InboxRecord | null, after: InboxRecord | null): InboxItem[] {
  if (!before || !after) return []
  const seen = new Set(requested(before).map((item) => item.url))
  const fresh = new Map<string, InboxItem>()
  for (const item of requested(after)) if (!seen.has(item.url)) fresh.set(item.url, item)
  return [...fresh.values()]
}

const inboxOf = (db: Database, userId: string) => getRecord<InboxRecord>(db, userId, 'inbox', 'inbox')

/**
 * Wraps a sync so new review requests in the inbox it brings are pushed to the user's other devices.
 * The device session that synced is left out: it fetched the inbox itself, so its app is running and
 * shows its own notification.
 */
export function inboxPushes(db: Database, push: PushSender, origin: string) {
  return <T>(userId: string, tokenId: string, changes: WireChange[], apply: () => T): T => {
    if (!changes.some((change) => change.kind === 'inbox')) return apply()
    const before = inboxOf(db, userId)
    const result = apply()
    const fresh = newReviewRequests(before, inboxOf(db, userId))
    if (fresh.length) push.send(userId, requestsMessage(fresh, origin), tokenId)
    return result
  }
}
