import { liveQuery } from 'dexie'
import type { ChannelSnapshot } from '../channel/client'
import type { CodeDuckyDb } from '../db/db'
import { INBOX_ID } from '../db/schema'
import { followBadge } from './badge'
import { deliver, RequestWatch, TaskWatch, type Notifier } from './notifications'
import type { PresencePrefs } from './presencePrefs'

/** How often the inbox is refetched in the background for review request notifications and the badge. */
export const INBOX_POLL_MS = 5 * 60_000

interface Store<T> {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => T
}

export interface PresenceDeps {
  db: CodeDuckyDb
  prefs: Store<PresencePrefs>
  channel: Store<ChannelSnapshot>
  notifier: Notifier
  /** Refetches the inbox when the cached one is stale; the snapshot it stores reaches the watchers. */
  pollInbox: () => Promise<void>
  setInterval?: (run: () => void, ms: number) => () => void
}

const everyInterval = (run: () => void, ms: number) => {
  const timer = setInterval(run, ms)
  return () => clearInterval(timer)
}

/** Runs `start` while `keyOf` gives a key for the current prefs, restarting it when the key changes. */
function whilePrefs<K>(prefs: Store<PresencePrefs>, keyOf: (prefs: PresencePrefs) => K | null, start: (key: K) => () => void) {
  let key: K | null = null
  let stop: (() => void) | null = null
  const apply = () => {
    const next = keyOf(prefs.getSnapshot())
    if (next === key) return
    stop?.()
    stop = null
    key = next
    if (next !== null) stop = start(next)
  }
  apply()
  const unsubscribe = prefs.subscribe(apply)
  return () => {
    unsubscribe()
    stop?.()
  }
}

function watchTasks(channel: Store<ChannelSnapshot>, notifier: Notifier) {
  const watch = new TaskWatch()
  const check = () => void deliver(watch.next(channel.getSnapshot()), notifier)
  // Subscribing keeps the channel's event stream open while the app is in the background.
  const unsubscribe = channel.subscribe(check)
  check()
  return unsubscribe
}

function watchRequests(db: CodeDuckyDb, notifier: Notifier) {
  const watch = new RequestWatch()
  const subscription = liveQuery(() => db.inbox.get(INBOX_ID)).subscribe({
    next: (snapshot) => void deliver(watch.next(snapshot), notifier),
    error: (error: unknown) => console.warn('Could not watch the inbox', error),
  })
  return () => subscription.unsubscribe()
}

/**
 * The app's presence outside its own pages: the icon badge, notifications for finished Claude tasks and
 * new review requests, and the background inbox refresh they rely on. Follows the prefs as they change.
 */
export function startPresence({ db, prefs, channel, notifier, pollInbox, setInterval = everyInterval }: PresenceDeps): () => void {
  const notifying = (p: PresencePrefs) => p.notifications && notifier.permission() === 'granted'
  const poll = () => void pollInbox().catch((error: unknown) => console.warn('Could not refresh the inbox', error))
  const stops = [
    whilePrefs(prefs, (p) => p.badge, (source) => followBadge(db, source)),
    whilePrefs(prefs, (p) => (notifying(p) && p.notifyTasks ? true : null), () => watchTasks(channel, notifier)),
    whilePrefs(prefs, (p) => (notifying(p) && p.notifyRequests ? true : null), () => watchRequests(db, notifier)),
    whilePrefs(
      prefs,
      (p) => ((notifying(p) && p.notifyRequests) || p.badge === 'requests' ? true : null),
      () => setInterval(poll, INBOX_POLL_MS),
    ),
  ]
  return () => stops.forEach((stop) => stop())
}
