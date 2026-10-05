import { HttpError } from '../sync/api'
import type { PresencePrefs } from './presencePrefs'

/** The parts of the Push API used here, so tests can stand in for the browser. */
export interface PushSubscriptionLike {
  readonly endpoint: string
  readonly options: { readonly applicationServerKey: ArrayBuffer | null }
  toJSON(): PushSubscriptionJSON
  unsubscribe(): Promise<boolean>
}

export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>
  subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array<ArrayBuffer> }): Promise<PushSubscriptionLike>
}

export interface PushDeps {
  /** This origin's service worker's push manager; null where the browser has no Web Push. */
  pushManager: () => Promise<PushManagerLike | null>
  /** The server's VAPID public key; null when the server has push turned off. */
  serverKey: () => Promise<string | null>
  /** An authenticated request to the Code Ducky server as this device. */
  request: (method: string, path: string, body?: unknown) => Promise<unknown>
}

/** What this device is pushed about; stored with its subscription on the server. */
export interface PushTypes {
  tasks: boolean
  requests: boolean
}

export const pushTypesOf = (prefs: PresencePrefs): PushTypes => ({ tasks: prefs.notifyTasks, requests: prefs.notifyRequests })

export class PushUnavailableError extends Error {
  constructor(reason: 'browser' | 'server') {
    super(reason === 'browser' ? 'This browser cannot receive push messages.' : 'The Code Ducky server has push turned off.')
  }
}

export function decodeKey(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '='))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

const sameKey = (current: ArrayBuffer | null, key: Uint8Array) => {
  if (!current || current.byteLength !== key.length) return false
  const bytes = new Uint8Array(current)
  return bytes.every((byte, index) => byte === key[index])
}

const register = (deps: PushDeps, subscription: PushSubscriptionLike, types: PushTypes) =>
  deps.request('POST', '/api/push/subscriptions', { subscription: subscription.toJSON(), prefs: types })

/**
 * Subscribes this browser (or reuses its subscription) and registers it with the server along with the
 * per-type choices. Safe to repeat: it is also how changed choices and a changed server key reach the server.
 */
export async function subscribePush(deps: PushDeps, types: PushTypes): Promise<void> {
  const manager = await deps.pushManager()
  if (!manager) throw new PushUnavailableError('browser')
  const serverKey = await deps.serverKey()
  if (!serverKey) throw new PushUnavailableError('server')
  const key = decodeKey(serverKey)
  const fresh = () => manager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  let subscription = await manager.getSubscription()
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe()
    subscription = null
  }
  subscription ??= await fresh()
  try {
    await register(deps, subscription, types)
  } catch (error) {
    // Another account registered this browser's endpoint and never signed out: start over with a new one.
    if (!(error instanceof HttpError && error.code === 'endpoint_taken')) throw error
    await subscription.unsubscribe()
    await register(deps, await fresh(), types)
  }
}

/** Removes this browser's subscription from the server (best effort) and from the browser. */
export async function unsubscribePush(deps: PushDeps): Promise<void> {
  const subscription = await (await deps.pushManager())?.getSubscription()
  if (!subscription) return
  await deps.request('DELETE', '/api/push/subscriptions', { endpoint: subscription.endpoint }).catch(() => undefined)
  await subscription.unsubscribe()
}

interface Store<T> {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => T
}

interface PrefsStore extends Store<PresencePrefs> {
  update: (changes: Partial<PresencePrefs>) => void
}

/** Push is wanted on this device: notifications on, the closed-app option on, and a signed-in server. */
const wanted = (prefs: PresencePrefs, signedIn: boolean) => prefs.notifications && prefs.push && signedIn

/**
 * This device's "even when Code Ducky is closed" option. Turning it on subscribes and registers with the
 * server; while it is on, changed per-type choices and each sign-in register again, which also repairs a
 * subscription the server dropped. Turning it off, or signing out, unsubscribes.
 */
export class PushController {
  /** The per-type choices last registered, so one change registers once. */
  private registered: string | null = null
  private readonly deps: PushDeps
  private readonly prefs: PrefsStore
  private readonly signedIn: Store<boolean>

  constructor(deps: PushDeps, prefs: PrefsStore, signedIn: Store<boolean>) {
    this.deps = deps
    this.prefs = prefs
    this.signedIn = signedIn
  }

  async enable(): Promise<void> {
    const types = pushTypesOf(this.prefs.getSnapshot())
    await subscribePush(this.deps, types)
    this.registered = JSON.stringify(types)
    this.prefs.update({ push: true })
  }

  async disable(): Promise<void> {
    this.registered = null
    this.prefs.update({ push: false })
    await unsubscribePush(this.deps)
  }

  /** Follows the prefs and the sign-in until the returned stop is called. */
  follow(onError: (error: unknown) => void): () => void {
    const apply = () => {
      const current = this.prefs.getSnapshot()
      const key = wanted(current, this.signedIn.getSnapshot()) ? JSON.stringify(pushTypesOf(current)) : null
      if (key === this.registered) return
      this.registered = key
      if (key) subscribePush(this.deps, pushTypesOf(current)).catch(onError)
    }
    const stops = [this.prefs.subscribe(apply), this.signedIn.subscribe(apply)]
    apply()
    return () => stops.forEach((stop) => stop())
  }
}
