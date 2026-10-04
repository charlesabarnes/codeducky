import { liveQuery } from 'dexie'
import type { CodeDuckyDb } from '../db/db'
import { INBOX_ID } from '../db/schema'
import type { BadgeSource } from './presencePrefs'

type BadgeDb = Pick<CodeDuckyDb, 'sessions' | 'notes' | 'inbox'>

export type BadgeApi = Pick<Navigator, 'setAppBadge' | 'clearAppBadge'>

/** The Badging API, where the browser has it. */
export function badgeApi(nav: Partial<BadgeApi> | undefined = globalThis.navigator): BadgeApi | null {
  return typeof nav?.setAppBadge === 'function' && typeof nav.clearAppBadge === 'function' ? (nav as BadgeApi) : null
}

/** Open notes in active sessions; archived sessions and resolved, suggested or dismissed notes do not count. */
export async function openNoteCount(db: BadgeDb): Promise<number> {
  const active = (await db.sessions.where('status').equals('active').primaryKeys()).filter((id) => id !== undefined)
  if (active.length === 0) return 0
  return db.notes
    .where('sessionId')
    .anyOf(active)
    .filter((note) => note.status === 'open')
    .count()
}

/** Pull requests waiting for your review in the last synced inbox. */
export async function reviewRequestCount(db: BadgeDb): Promise<number> {
  const snapshot = await db.inbox.get(INBOX_ID)
  return snapshot?.items.filter((item) => item.section === 'requested').length ?? 0
}

export function badgeCount(db: BadgeDb, source: BadgeSource): Promise<number> {
  if (source === 'notes') return openNoteCount(db)
  if (source === 'requests') return reviewRequestCount(db)
  return Promise.resolve(0)
}

/** Sets the badge to the count, or clears it at zero. */
export async function applyBadge(api: BadgeApi, count: number): Promise<void> {
  if (count > 0) await api.setAppBadge(count)
  else await api.clearAppBadge()
}

/** Keeps the app icon's badge on the source's count as the data changes. Returns a function that stops following. */
export function followBadge(db: BadgeDb, source: BadgeSource, api: BadgeApi | null = badgeApi()): () => void {
  if (!api) return () => undefined
  const report = (error: unknown) => console.warn('Could not update the app badge', error)
  if (source === 'off') {
    applyBadge(api, 0).catch(report)
    return () => undefined
  }
  const subscription = liveQuery(() => badgeCount(db, source)).subscribe({
    next: (count) => void applyBadge(api, count).catch(report),
    error: report,
  })
  return () => subscription.unsubscribe()
}
