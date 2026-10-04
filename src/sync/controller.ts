import { liveQuery, type Subscription } from 'dexie'
import type { SyncResponse } from '../../shared/sync'
import { wipeAccountData } from '../db/accountData'
import type { CodeDuckyDb } from '../db/db'
import { apiRequest, HttpError, NetworkError, UnauthorizedError, type ApiOptions } from './api'
import { enqueueAll, runSync } from './engine'
import {
  META_ACCOUNT,
  META_AUTH,
  META_CURSOR,
  META_LAST_SYNCED_AT,
  getMeta,
  setMeta,
  type BoundAccount,
  type SessionUser,
  type StoredAuth,
} from './meta'
import { challengeOf, createVerifier } from './pkce'
import { discardRejected, retryRejected } from './rejected'

export type AuthState = 'loading' | 'signedOut' | 'signedIn' | 'expired'
export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'unreachable' | 'error'
export type SignInResult = 'ok' | 'needsSwitch' | 'invalid' | 'disabled' | 'offline' | 'error'
export type AdminSignInResult = SignInResult | 'throttled' | 'unavailable'

export interface Usage {
  records: number
  bytes: number
}

/** A sign-in to a different account than the one this browser's data belongs to, waiting for confirmation. */
export interface SwitchRequest {
  from: BoundAccount
  to: SessionUser
  /** Local changes that never reached `from`'s account. */
  unsent: number
  returnTo: string
}

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
  user: SessionUser | null
  usage: Usage | null
  quota: Usage | null
  switchRequest: SwitchRequest | null
}

interface SessionReply {
  tokenId: string
  name: string
  kind: string
  user: SessionUser
  usage: Usage
  quota: Usage
}

interface SignInReply {
  token: string
  tokenId: string
  user: SessionUser
}

/** What the tab that starts a GitHub sign-in keeps for the callback. */
interface PendingSignIn {
  verifier: string
  name: string
  returnTo: string
}

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

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
  /** Holds the PKCE verifier across the GitHub round-trip; sessionStorage in the browser. */
  sessionStorage?: KeyValueStore
  /** Leaves the app for the sign-in start URL; location.assign in the browser. */
  navigate?: (url: string) => void
}

const SIGNED_OUT = { status: 'idle', lastError: null, deviceName: null, user: null, usage: null, quota: null } as const

const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false

export const PENDING_SIGN_IN_KEY = 'codeducky.signIn'
export const DEFAULT_RETURN_TO = '/settings#sync'

/** Only same-origin paths, so a stored value can never send the browser elsewhere. */
export const safeReturnTo = (path: unknown): string =>
  typeof path === 'string' && /^\/(?![/\\])/.test(path) ? path : DEFAULT_RETURN_TO

const bindingOf = (user: SessionUser): BoundAccount => ({ id: user.id, login: user.login })

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
    user: null,
    usage: null,
    quota: null,
    switchRequest: null,
  }
  private readonly listeners = new Set<() => void>()
  private readonly api: ApiOptions
  private readonly debounceMs: number
  private readonly intervalMs: number
  private readonly retryMs: number
  private readonly listenToBrowser: boolean
  private readonly sessionStorage: () => KeyValueStore | undefined
  private readonly navigate: (url: string) => void
  private auth: StoredAuth | null = null
  /** The new account's sign-in, held until the user confirms or cancels the switch. */
  private pendingSwitch: StoredAuth | null = null
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
    this.sessionStorage = () => options.sessionStorage ?? (typeof sessionStorage === 'undefined' ? undefined : sessionStorage)
    this.navigate = options.navigate ?? ((url) => window.location.assign(url))
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
    this.update({
      auth: this.auth ? 'signedIn' : 'signedOut',
      lastSyncedAt,
      deviceName: this.auth?.name ?? null,
      user: this.auth?.user ?? null,
    })
    if (this.auth) {
      this.startTriggers()
      void this.refreshSession()
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

  /** Starts the GitHub round-trip; the browser comes back at /signin/callback, which calls completeSignIn. */
  async beginGitHubSignIn(name: string, returnTo = DEFAULT_RETURN_TO): Promise<void> {
    const verifier = createVerifier()
    const pending: PendingSignIn = { verifier, name, returnTo: safeReturnTo(returnTo) }
    this.sessionStorage()?.setItem(PENDING_SIGN_IN_KEY, JSON.stringify(pending))
    this.navigate(`${this.api.baseUrl}/api/auth/github/start?challenge=${encodeURIComponent(await challengeOf(verifier))}`)
  }

  /** Where the browser should go once the sign-in under way finishes. */
  pendingReturnTo(): string {
    return safeReturnTo(this.readPendingSignIn()?.returnTo)
  }

  /** Swaps the callback's one-time hand-off code for a session token, using the verifier this tab kept. */
  async completeSignIn(handoff: string): Promise<SignInResult> {
    await this.start()
    const pending = this.readPendingSignIn()
    this.sessionStorage()?.removeItem(PENDING_SIGN_IN_KEY)
    if (!pending?.verifier) return 'invalid'
    let reply: SignInReply
    try {
      reply = await apiRequest(this.api, 'POST', '/api/auth/exchange', {
        body: { handoff, verifier: pending.verifier, name: pending.name },
      })
    } catch (error) {
      if (error instanceof UnauthorizedError) return 'invalid'
      if (error instanceof NetworkError) return 'offline'
      if (error instanceof HttpError && error.code === 'account_disabled') return 'disabled'
      if (error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 429) return 'invalid'
      return 'error'
    }
    return this.adopt(reply, pending.name, safeReturnTo(pending.returnTo))
  }

  /** Signs in to the built-in admin account with the server's admin passphrase. */
  async adminSignIn(passphrase: string, name: string, returnTo = DEFAULT_RETURN_TO): Promise<AdminSignInResult> {
    await this.start()
    let reply: SignInReply
    try {
      reply = await apiRequest(this.api, 'POST', '/api/auth/admin/login', { body: { passphrase, name } })
    } catch (error) {
      if (error instanceof UnauthorizedError) return 'invalid'
      if (error instanceof NetworkError) return 'offline'
      if (error instanceof HttpError && error.status === 429) return 'throttled'
      if (error instanceof HttpError && error.status === 404) return 'unavailable'
      return 'error'
    }
    return this.adopt(reply, name, safeReturnTo(returnTo))
  }

  /**
   * Takes a new sign-in. A browser with no account yet, or the same account, keeps its data and
   * uploads it; a different account must first confirm that this browser's data is removed.
   */
  private async adopt(reply: SignInReply, name: string, returnTo: string): Promise<SignInResult> {
    const auth: StoredAuth = { token: reply.token, tokenId: reply.tokenId, name, user: reply.user }
    const bound = await getMeta<BoundAccount>(this.db, META_ACCOUNT)
    if (bound && bound.id !== reply.user.id) {
      this.pendingSwitch = auth
      this.update({ switchRequest: { from: bound, to: reply.user, unsent: await this.db.outbox.count(), returnTo } })
      return 'needsSwitch'
    }
    await setMeta(this.db, META_ACCOUNT, bindingOf(reply.user))
    await this.activate(auth)
    return 'ok'
  }

  private async activate(auth: StoredAuth) {
    this.auth = auth
    await setMeta(this.db, META_AUTH, auth)
    // A fresh sign-in pulls everything and uploads everything; last-write-wins sorts out the overlap.
    await setMeta(this.db, META_CURSOR, 0)
    await enqueueAll(this.db)
    this.update({ auth: 'signedIn', deviceName: auth.name, user: auth.user ?? null, lastError: null, status: 'idle' })
    this.startTriggers()
    void this.refreshSession()
    await this.sync()
  }

  /**
   * Removes the previous account's data from this browser and keeps the new sign-in. The caller
   * reloads the page afterwards, so no in-memory state from the previous account survives.
   */
  async confirmSwitch(): Promise<void> {
    const auth = this.pendingSwitch
    if (!auth?.user) return
    this.stop()
    await this.inFlight?.catch(() => undefined)
    try {
      await wipeAccountData(this.db)
    } catch (error) {
      if (this.auth) this.startTriggers()
      throw error
    }
    await setMeta(this.db, META_ACCOUNT, bindingOf(auth.user))
    await setMeta(this.db, META_AUTH, auth)
    this.pendingSwitch = null
    this.auth = auth
    this.update({ auth: 'signedIn', deviceName: auth.name, user: auth.user, switchRequest: null })
  }

  /** Keeps this browser's data and revokes the new sign-in's token. */
  async cancelSwitch(): Promise<void> {
    const auth = this.pendingSwitch
    this.pendingSwitch = null
    this.update({ switchRequest: null })
    if (auth) await apiRequest(this.api, 'POST', '/api/auth/logout', { token: auth.token }).catch(() => undefined)
  }

  /** Refreshes the profile, usage and quota; a revoked token or disabled account expires the sign-in. */
  async refreshSession(): Promise<void> {
    const auth = this.auth
    if (!auth || !isOnline()) return
    let reply: SessionReply
    try {
      reply = await this.request<SessionReply>('GET', '/api/auth/session')
    } catch {
      return
    }
    if (this.auth !== auth) return
    if (JSON.stringify(auth.user) !== JSON.stringify(reply.user)) {
      this.auth = { ...auth, user: reply.user }
      await setMeta(this.db, META_AUTH, this.auth)
    }
    this.update({ user: reply.user, usage: reply.usage ?? null, quota: reply.quota ?? null })
  }

  private readPendingSignIn(): PendingSignIn | null {
    try {
      return JSON.parse(this.sessionStorage()?.getItem(PENDING_SIGN_IN_KEY) ?? 'null') as PendingSignIn | null
    } catch {
      return null
    }
  }

  /** Revokes this device's token (best effort) and stops syncing. Local data and unsent changes stay. */
  async signOut(): Promise<void> {
    const auth = await this.halt()
    this.throttledUntil = 0
    await this.db.syncMeta.bulkDelete([META_AUTH, META_CURSOR, META_LAST_SYNCED_AT])
    this.update({ ...SIGNED_OUT, auth: 'signedOut', lastSyncedAt: null })
    if (auth) await apiRequest(this.api, 'POST', '/api/auth/logout', { token: auth.token }).catch(() => undefined)
  }

  /** Signs out and removes every account's data from this browser, for shared computers. */
  async signOutAndRemoveData(): Promise<void> {
    await this.signOut()
    await wipeAccountData(this.db)
  }

  /** Deletes the signed-in account on the server, then its data in this browser. */
  async deleteAccount(confirm: string): Promise<void> {
    await this.request<{ ok: true }>('DELETE', '/api/account', { confirm })
    await this.halt()
    await wipeAccountData(this.db)
    this.update({ ...SIGNED_OUT, auth: 'signedOut', lastSyncedAt: null })
  }

  /** Drops the sign-in first, so a sync still running sends nothing more, then waits for it to end. */
  private async halt(): Promise<StoredAuth | null> {
    const auth = this.auth
    this.auth = null
    this.stop()
    this.rerun = false
    await this.inFlight?.catch(() => undefined)
    return auth
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
      const result = await runSync(this.db, (request) => {
        if (this.auth !== auth) throw new UnauthorizedError()
        return apiRequest<SyncResponse>(this.api, 'POST', '/api/sync', { body: request, token: auth.token })
      })
      this.update({ status: 'idle', lastSyncedAt: result.syncedAt, lastError: null })
    } catch (error) {
      if (this.auth !== auth) return
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

  /** The token was revoked, expired or its account disabled: stop and ask for a new sign-in. */
  private async expire() {
    this.stop()
    this.auth = null
    await this.db.syncMeta.delete(META_AUTH)
    this.update({ ...SIGNED_OUT, auth: 'expired' })
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
    const onFocus = () => {
      syncNow()
      void this.refreshSession()
    }
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') syncNow()
    }, this.intervalMs)
    const cleanups = [() => clearInterval(timer)]
    if (this.listenToBrowser && typeof window !== 'undefined') {
      const onVisible = () => document.visibilityState === 'visible' && syncNow()
      window.addEventListener('online', syncNow)
      window.addEventListener('focus', onFocus)
      document.addEventListener('visibilitychange', onVisible)
      cleanups.push(() => {
        window.removeEventListener('online', syncNow)
        window.removeEventListener('focus', onFocus)
        document.removeEventListener('visibilitychange', onVisible)
      })
    }
    this.stopTriggers = () => cleanups.forEach((cleanup) => cleanup())
  }
}
