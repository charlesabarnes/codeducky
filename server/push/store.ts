import type { Database } from 'bun:sqlite'
import type { PushTarget } from './webPush'

/**
 * The only module that reads or writes push_subscriptions. A subscription belongs to the user and to
 * the device session that registered it, so signing that device out (or revoking its session) drops it.
 */

/** Subscriptions kept per user; registering another drops the least recently used. */
export const MAX_SUBSCRIPTIONS = 10

/** What a subscription is notified about; the PWA's per-type toggles. */
export interface PushPrefs {
  tasks: boolean
  requests: boolean
}

export type PushType = keyof PushPrefs

export interface Subscription extends PushTarget {
  id: number
  tokenId: string
  prefs: PushPrefs
  createdAt: number
  lastUsedAt: number | null
  failures: number
}

interface Row {
  id: number
  token_id: string
  endpoint: string
  p256dh: string
  auth: string
  notify_tasks: number
  notify_requests: number
  created_at: number
  last_used_at: number | null
  failures: number
}

const COLUMNS = 'id, token_id, endpoint, p256dh, auth, notify_tasks, notify_requests, created_at, last_used_at, failures'

const toSubscription = (row: Row): Subscription => ({
  id: row.id,
  tokenId: row.token_id,
  endpoint: row.endpoint,
  p256dh: row.p256dh,
  auth: row.auth,
  prefs: { tasks: row.notify_tasks === 1, requests: row.notify_requests === 1 },
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  failures: row.failures,
})

export type SaveResult = 'created' | 'updated' | 'taken'

/**
 * Registers a subscription, or updates the keys and prefs of one the user already has. An endpoint
 * registered by another user is refused ('taken'); the browser then subscribes again for a new one.
 */
export function saveSubscription(db: Database, userId: string, tokenId: string, target: PushTarget, prefs: PushPrefs, now = Date.now()): SaveResult {
  return db.transaction((): SaveResult => {
    const owner = db.query<{ user_id: string }, [string]>('SELECT user_id FROM push_subscriptions WHERE endpoint = ?').get(target.endpoint)
    if (owner && owner.user_id !== userId) return 'taken'
    db.query(
      `INSERT INTO push_subscriptions (user_id, token_id, endpoint, p256dh, auth, notify_tasks, notify_requests, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET token_id = excluded.token_id, p256dh = excluded.p256dh, auth = excluded.auth,
         notify_tasks = excluded.notify_tasks, notify_requests = excluded.notify_requests, failures = 0`,
    ).run(userId, tokenId, target.endpoint, target.p256dh, target.auth, prefs.tasks ? 1 : 0, prefs.requests ? 1 : 0, now)
    db.query(
      `DELETE FROM push_subscriptions WHERE id IN (
         SELECT id FROM push_subscriptions WHERE user_id = ?
         ORDER BY coalesce(last_used_at, created_at) DESC, id DESC LIMIT -1 OFFSET ?)`,
    ).run(userId, MAX_SUBSCRIPTIONS)
    return owner ? 'updated' : 'created'
  })()
}

/** Only the user's own subscription; another user's endpoint is treated as unknown. */
export function deleteSubscription(db: Database, userId: string, endpoint: string): boolean {
  return db.query('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint).changes > 0
}

export function deleteUserSubscriptions(db: Database, userId: string): number {
  return db.query('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId).changes
}

export function listSubscriptions(db: Database, userId: string): Subscription[] {
  return db.query<Row, [string]>(`SELECT ${COLUMNS} FROM push_subscriptions WHERE user_id = ? ORDER BY id`).all(userId).map(toSubscription)
}

/** The user's subscriptions that want `type`, leaving out the device session `exceptTokenId`. */
export function subscriptionsFor(db: Database, userId: string, type: PushType, exceptTokenId: string | null = null): Subscription[] {
  const column = type === 'tasks' ? 'notify_tasks' : 'notify_requests'
  return db
    .query<Row, [string, string]>(`SELECT ${COLUMNS} FROM push_subscriptions WHERE user_id = ? AND ${column} = 1 AND token_id IS NOT ? ORDER BY id`)
    .all(userId, exceptTokenId ?? '')
    .map(toSubscription)
}

export function markDelivered(db: Database, userId: string, id: number, now = Date.now()): void {
  db.query('UPDATE push_subscriptions SET last_used_at = ?, failures = 0 WHERE id = ? AND user_id = ?').run(now, id, userId)
}

/** Counts a failed delivery; returns the failures in a row, or null when the subscription is gone. */
export function recordFailure(db: Database, userId: string, id: number): number | null {
  return (
    db
      .query<{ failures: number }, [number, string]>('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ? AND user_id = ? RETURNING failures')
      .get(id, userId)?.failures ?? null
  )
}

export function removeSubscription(db: Database, userId: string, id: number): void {
  db.query('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').run(id, userId)
}
