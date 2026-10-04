import { channelClient } from '../channel/client'
import { db } from '../db/db'
import { fetchAndStoreInbox, inboxIsStale } from '../features/inbox/useInbox'
import { browserView, isAppPath, NAVIGATE_MESSAGE, notificationPermission, showBrowserNotification } from './notifications'
import { startPresence } from './presence'
import { presencePrefs } from './presencePrefs'

/** Starts the badge and notifications for this window; `navigate` moves the app's router. */
export function startBrowserPresence(navigate: (path: string) => void): () => void {
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; path?: unknown } | null
    if (data?.type === NAVIGATE_MESSAGE && isAppPath(data.path)) navigate(data.path)
  }
  navigator.serviceWorker?.addEventListener('message', onMessage)
  const stop = startPresence({
    db,
    prefs: presencePrefs,
    channel: channelClient,
    notifier: { permission: notificationPermission, view: browserView, show: (notice) => showBrowserNotification(notice, navigate) },
    pollInbox: async () => {
      if (inboxIsStale()) await fetchAndStoreInbox()
    },
  })
  return () => {
    navigator.serviceWorker?.removeEventListener('message', onMessage)
    stop()
  }
}
