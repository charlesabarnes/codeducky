import { liveQuery, type Subscription } from 'dexie'
import type { SyncResponse } from '../../shared/sync'
import type { CodeDuckyDb } from '../db/db'
import { apiRequest, HttpError, NetworkError, UnauthorizedError, type ApiOptions } from './api'
import { enqueueAll, runSync } from './engine'
import { META_AUTH, META_CURSOR, META_LAST_SYNCED_AT, getMeta, setMeta, type StoredAuth } from './meta'
import { discardRejected, retryRejected } from './rejected'

export type AuthState = 'loading' | 'signedOut' | 'signedIn' | 'expired'
export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'unreachable' | 'error'
export type SignInResult = 'ok' | 'invalid' | 'throttled' | 'offline' | 'error'

export interface SyncSnapshot {
  auth: AuthState
  status: SyncStatus
  /** Local writes waiting to upload. */
  pending: number
  /** Writes the server refused. */
  rejected: number
  lastSyncedAt: number | null
  lastError: string | null
  deviceName: string | null
}

export interface TokenSummary {
  id: string
  name: string
  kind: 'session' | 'api' | 'oauth'
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  current: boolean
}

export interface ControllerOptions {
  baseUrl?: string
  fetch?: typeof fetch
  debounceMs?: number
  intervalMs?: number
  retryMs?: number
  /** Browser events (focus, online, visibility) trigger syncs; off in tests. */
  listenToBrowser?: boolean
}

const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false

/**
 * Owns sign-in and the sync loop: syncs after local writes (debounced), when the window
 * regains focus or the network returns, and periodically. Everything works offline; the
 * outbox simply waits.
 */
export class SyncController {
  private snapshot: SyncSnapshot = {
    auth: 'loading',
    status: 'idle',
    pending: 0,
    rejected: 0,
    lastSyncedAt: null,
    lastError: null,
    deviceName: null,
  }
  private readonly listeners = new Set<() => void>()
  private readonly api: ApiOptions
  private readonly debounceMs: number
  private readonly intervalMs: number
  private readonly retryMs: number
  private readonly listenToBrowser: boolean
  private auth: StoredAuth | null = null
  private started: Promise<void> | null = null
  private subscriptions: Subscription[] = []
  private stopTriggers: (() => void) | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  /** Until when the server asked us (Retry-After) not to sync. */
  private throttledUntil = 0
  private inFlight: Promise<void> | null = null
  private rerun = false

  private readonly db: CodeDuckyDb

  constructor(db: CodeDuckyDb, options: ControllerOptions = {}) {
    this.db = db
    this.api = { baseUrl: options.baseUrl ?? '', fetch: options.fetch ?? ((...args) => fetch(...args)) }
    this.debounceMs = options.debounceMs ?? 1500
    this.intervalMs = options.intervalMs ?? 60_000
    this.retryMs = options.retryMs ?? 30_000
    this.listenToBrowser = options.listenToBrowser ?? true
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = () => this.snapshot

  private update(changes: Partial<SyncSnapshot>) {
    this.snapshot = { ...this.snapshot, ...changes }
    this.listeners.forEach((listener) => listener())
  }

  start(): Promise<void> {
    this.started ??= this.load()
    return this.started
  }

  private async load() {
    this.subscriptions.push(
      liveQuery(() => this.db.outbox.count()).subscribe((pending) => {
        this.update({ pending })
        if (pending > 0) this.scheduleSoon()
      }),
      liveQuery(() => this.db.rejected.count()).subscribe((rejected) => this.update({ rejected })),
    )
    this.auth = (await getMeta<StoredAuth>(this.db, META_AUTH)) ?? null
    const lastSyncedAt = (await getMeta<number>(this.db, META_LAST_SYNCED_AT)) ?? null
    this.update({ auth: this.auth ? 'signedIn' : 'signedOut', lastSyncedAt, deviceName: this.auth?.name ?? null })
    if (this.auth) {
      this.startTriggers()
      void this.sync()
    }
  }

  /** Stops timers and listeners; used by tests and on sign-out. */
  stop(): void {
    this.stopTriggers?.()
    this.stopTriggers = null
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.debounceTimer = this.retryTimer = null
  }

  dispose(): void {
    this.stop()
    this.subscriptions.forEach((s) => s.unsubscribe())
    this.subscriptions = []
  }

  async signIn(passphrase: string, name: string): Promise<SignInResult> {
    await this.start()
    let reply: { token: string; tokenId: string }
    try {
      reply = await apiRequest(this.api, 'POST', '/api/auth/login', { body: { passphrase, name } })
    } catch (error) {
      if (error instanceof UnauthorizedError) return 'invalid'
      if (error instanceof NetworkError) return 'offline'
      if (error instanceof HttpError && error.status === 429) return 'throttled'
      return 'error'
    }
    this.auth = { token: reply.token, tokenId: reply.tokenId, name }
    await setMeta(this.db, META_AUTH, this.auth)
    // A fresh sign-in pulls everything and uploads everything; last-write-wins sorts out the overlap.
    await setMeta(this.db, META_CURSOR, 0)
    await enqueueAll(this.db)
    this.update({ auth: 'signedIn', deviceName: name, lastError: null, status: 'idle' })
    this.startTriggers()
    await this.sync()
    return 'ok'
  }

  /** Revokes this device's token (best effort) and stops syncing. Local data and unsent changes stay. */
  async signOut(): Promise<void> {
    this.stop()
    this.rerun = false
    await this.inFlight?.catch(() => undefined)
    this.throttledUntil = 0
    const auth = this.auth
    this.auth = null
    await this.db.syncMeta.bulkDelete([META_AUTH, META_CURSOR, META_LAST_SYNCED_AT])
    this.update({ auth: 'signedOut', status: 'idle', lastError: null, lastSyncedAt: null, deviceName: null })
    if (auth) await apiRequest(this.api, 'POST', '/api/auth/logout', { token: auth.token }).catch(() => undefined)
  }

  /** Runs a sync now; calls made while one runs coalesce into a single follow-up run. */
  sync(): Promise<void> {
    if (this.inFlight) {
      this.rerun = true
      return this.inFlight
    }
    this.inFlight = this.loop().finally(() => (this.inFlight = null))
    return this.inFlight
  }

  /** This device's bearer token, for requests apiRequest cannot make (streamed responses). */
  authToken(): string | null {
    return this.auth?.token ?? null
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.auth) throw new UnauthorizedError()
    try {
      return await apiRequest<T>(this.api, method, path, { body, token: this.auth.token })
    } catch (error) {
      if (error instanceof UnauthorizedError) await this.expire()
      throw error
    }
  }

  listTokens() {
    return this.request<{ tokens: TokenSummary[] }>('GET', '/api/auth/tokens').then((r) => r.tokens)
  }

  mintToken(name: string) {
    return this.request<{ token: string; info: TokenSummary }>('POST', '/api/auth/tokens', { name })
  }

  revokeToken(id: string) {
    return this.request<{ ok: true }>('DELETE', `/api/auth/tokens/${encodeURIComponent(id)}`)
  }

  async retryRejected(key: string) {
    await retryRejected(this.db, key)
    void this.sync()
  }

  async discardRejected(key: string) {
    await discardRejected(this.db, key)
    void this.sync()
  }

  private async loop() {
    do {
      this.rerun = false
      await this.once()
    } while (this.rerun && this.auth)
  }

  private async once() {
    const auth = this.auth
    if (!auth || Date.now() < this.throttledUntil) return
    if (!isOnline()) {
      this.update({ status: 'offline' })
      return
    }
    this.update({ status: 'syncing' })
    try {
      const result = await runSync(this.db, (request) =>
        apiRequest<SyncResponse>(this.api, 'POST', '/api/sync', { body: request, token: auth.token }),
      )
      this.update({ status: 'idle', lastSyncedAt: result.syncedAt, lastError: null })
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        await this.expire()
        return
      }
      const status = error instanceof NetworkError ? (isOnline() ? 'unreachable' : 'offline') : 'error'
      this.update({ status, lastError: error instanceof Error ? error.message : String(error) })
      const retryAfterMs = error instanceof HttpError ? error.retryAfterMs : null
      if (retryAfterMs !== null) this.throttledUntil = Date.now() + retryAfterMs
      this.scheduleRetry(retryAfterMs)
    }
  }

  /** The token was revoked or the server forgot it: stop and ask for the passphrase again. */
  private async expire() {
    this.stop()
    this.auth = null
    await this.db.syncMeta.delete(META_AUTH)
    this.update({ auth: 'expired', status: 'idle', deviceName: null })
  }

  private scheduleSoon() {
    if (!this.auth || !this.stopTriggers) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.sync()
    }, this.debounceMs)
  }

  private scheduleRetry(delayMs: number | null = null) {
    if (!this.stopTriggers) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.sync()
    }, delayMs ?? this.retryMs)
  }

  private startTriggers() {
    if (this.stopTriggers) return
    const syncNow = () => void this.sync()
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') syncNow()
    }, this.intervalMs)
    const cleanups = [() => clearInterval(timer)]
    if (this.listenToBrowser && typeof window !== 'undefined') {
      const onVisible = () => document.visibilityState === 'visible' && syncNow()
      window.addEventListener('online', syncNow)
      window.addEventListener('focus', syncNow)
      document.addEventListener('visibilitychange', onVisible)
      cleanups.push(() => {
        window.removeEventListener('online', syncNow)
        window.removeEventListener('focus', syncNow)
        document.removeEventListener('visibilitychange', onVisible)
      })
    }
    this.stopTriggers = () => cleanups.forEach((cleanup) => cleanup())
  }
}
