import { useSyncExternalStore } from 'react'
import type { ChannelState, ChannelTaskView, PermissionBehavior, TaskRequest } from '../../shared/channel'
import { syncController } from '../sync/client'
import { readSse } from './sse'

export type ChannelStatus = 'signedOut' | 'connecting' | 'live' | 'retrying'

export interface ChannelSnapshot {
  status: ChannelStatus
  state: ChannelState
}

const EMPTY: ChannelState = { sessions: [], tasks: [], permissions: [] }
const MAX_DELAY_MS = 30_000

interface Deps {
  token: () => string | null
  /** Called when the sign-in may have changed, so a stream can start. */
  onAuthChange: (listener: () => void) => () => void
  request: <T>(method: string, path: string, body?: unknown) => Promise<T>
  fetch?: typeof fetch
  baseUrl?: string
}

/**
 * Follows /api/channel/events while anything on screen is subscribed: the connected Claude Code
 * sessions, the tasks sent to them and their permission prompts. Reconnects with backoff.
 */
export class ChannelClient {
  private snapshot: ChannelSnapshot = { status: 'connecting', state: EMPTY }
  private readonly listeners = new Set<() => void>()
  private abort: AbortController | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stopAuth: (() => void) | null = null
  private attempt = 0
  private readonly deps: Deps

  constructor(deps: Deps) {
    this.deps = deps
  }

  readonly getSnapshot = () => this.snapshot

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) this.start()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stop()
    }
  }

  private update(changes: Partial<ChannelSnapshot>) {
    this.snapshot = { ...this.snapshot, ...changes }
    this.listeners.forEach((listener) => listener())
  }

  private start() {
    this.stopAuth = this.deps.onAuthChange(() => {
      const signedIn = this.deps.token() !== null
      if (signedIn && this.snapshot.status === 'signedOut') this.connect()
      if (!signedIn && this.snapshot.status !== 'signedOut') {
        this.abort?.abort()
        this.update({ status: 'signedOut', state: EMPTY })
      }
    })
    this.connect()
  }

  private stop() {
    this.stopAuth?.()
    this.stopAuth = null
    this.abort?.abort()
    this.abort = null
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private connect() {
    const token = this.deps.token()
    if (!token) {
      this.update({ status: 'signedOut', state: EMPTY })
      return
    }
    this.abort?.abort()
    const abort = new AbortController()
    this.abort = abort
    if (this.snapshot.status !== 'live') this.update({ status: this.attempt === 0 ? 'connecting' : 'retrying' })
    void this.follow(token, abort).finally(() => {
      if (abort.signal.aborted || this.abort !== abort) return
      const delay = Math.min(MAX_DELAY_MS, 1000 * 2 ** this.attempt++)
      this.update({ status: 'retrying' })
      this.retryTimer = setTimeout(() => this.connect(), delay)
    })
  }

  private async follow(token: string, abort: AbortController) {
    const fetchImpl = this.deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
    try {
      const res = await fetchImpl(`${this.deps.baseUrl ?? ''}/api/channel/events`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        signal: abort.signal,
        cache: 'no-store',
      })
      if (!res.ok || !res.body) return
      for await (const event of readSse(res.body)) {
        if (event.event !== 'state') continue
        this.attempt = 0
        this.update({ status: 'live', state: JSON.parse(event.data) as ChannelState })
      }
    } catch {
      // Network errors and aborts end the stream; connect() decides whether to retry.
    }
  }

  sendTask(channelId: string, task: TaskRequest) {
    return this.deps.request<{ task: ChannelTaskView }>('POST', `/api/channel/sessions/${encodeURIComponent(channelId)}/tasks`, task)
  }

  decide(channelId: string, requestId: string, behavior: PermissionBehavior) {
    return this.deps.request<{ ok: true }>(
      'POST',
      `/api/channel/sessions/${encodeURIComponent(channelId)}/permissions/${encodeURIComponent(requestId)}`,
      { behavior },
    )
  }
}

export const channelClient = new ChannelClient({
  token: () => syncController.authToken(),
  onAuthChange: (listener) => syncController.subscribe(listener),
  request: (method, path, body) => syncController.request(method, path, body),
})

export function useChannel(): ChannelSnapshot {
  return useSyncExternalStore(channelClient.subscribe, channelClient.getSnapshot)
}
