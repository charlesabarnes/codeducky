import { useCallback, useEffect, useRef, useState } from 'react'
import { readJson, writeJson } from '../../app/storage'
import { db } from '../../db/db'
import { INBOX_ID } from '../../db/schema'
import { githubClient } from '../../github/connect'
import { errorMessage, isGitHubError } from '../../github/errors'
import { fetchInbox, inboxSnapshotItems, sameItems, type Inbox } from '../../github/inbox'

const STORAGE_KEY = 'skelbert.inbox'
/** Refetch on focus only when the cached inbox is older than this. */
export const INBOX_STALE_MS = 60_000

export type InboxState =
  | { status: 'loading' }
  | { status: 'no-token' }
  | { status: 'error'; message: string; forbidden: boolean; inbox: Inbox | null }
  | { status: 'ready'; inbox: Inbox; refreshing: boolean }

/** Shares the lightweight inbox with other devices and MCP clients; skipped when nothing changed. */
async function syncSnapshot(inbox: Inbox): Promise<void> {
  const items = inboxSnapshotItems(inbox)
  const stored = await db.inbox.get(INBOX_ID)
  if (sameItems(stored?.items, items)) return
  await db.inbox.put({ id: INBOX_ID, fetchedAt: inbox.fetchedAt, items })
}

/** The inbox, shown from cache at once and refreshed when stale, on window focus, and on demand. */
export function useInbox() {
  const [state, setState] = useState<InboxState>(() => {
    const cached = readJson<Inbox>(STORAGE_KEY)
    return cached ? { status: 'ready', inbox: cached, refreshing: Date.now() - cached.fetchedAt >= INBOX_STALE_MS } : { status: 'loading' }
  })
  const inFlight = useRef(false)

  const refresh = useCallback(async (force: boolean) => {
    const cached = readJson<Inbox>(STORAGE_KEY)
    if (!force && cached && Date.now() - cached.fetchedAt < INBOX_STALE_MS) return
    if (inFlight.current) return
    inFlight.current = true
    setState((current) => (current.status === 'ready' ? { ...current, refreshing: true } : current))
    try {
      const gh = await githubClient()
      if (!gh) return setState({ status: 'no-token' })
      const inbox = await fetchInbox(gh)
      writeJson(STORAGE_KEY, inbox)
      setState({ status: 'ready', inbox, refreshing: false })
      await syncSnapshot(inbox).catch((error: unknown) => console.warn('Could not save the inbox snapshot', error))
    } catch (error) {
      setState({ status: 'error', message: errorMessage(error), forbidden: isGitHubError(error, 'forbidden') || isGitHubError(error, 'bad-token'), inbox: cached })
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    const first = setTimeout(() => void refresh(false), 0)
    const onFocus = () => void refresh(false)
    const onVisible = () => document.visibilityState === 'visible' && onFocus()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearTimeout(first)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  return { state, refresh: () => refresh(true) }
}
