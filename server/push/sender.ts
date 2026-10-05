import type { Database } from 'bun:sqlite'
import type { RateLimiter } from '../limits'
import type { LogSink } from '../log'
import type { PushMessage } from './messages'
import { markDelivered, recordFailure, removeSubscription, subscriptionsFor, type Subscription } from './store'
import { buildPushRequest, createVapidSigner, type PushRequest, type VapidKeys } from './webPush'

/** Delivers one request to a push service and gives back its HTTP status. */
export type PushTransport = (request: PushRequest) => Promise<{ status: number }>

export interface PushSenderOptions {
  db: Database
  vapid: VapidKeys
  /** Per-user rate of pushes (CODEDUCKY_RATE_PUSH); one message to all of a user's devices counts once. */
  limiter: RateLimiter
  log: LogSink
  transport?: PushTransport
  now?: () => number
}

/** Failed deliveries in a row after which a subscription is dropped. */
export const MAX_FAILURES = 5
/** How long a push service keeps a message for a device that is offline. */
const TTL_SEC = 24 * 60 * 60
const TIMEOUT_MS = 10_000

export const fetchTransport: PushTransport = async ({ endpoint, headers, body }) => {
  const res = await fetch(endpoint, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) })
  await res.body?.cancel()
  return { status: res.status }
}

/** Only the push service's host goes in the log: the endpoint path is a capability, like a token. */
const hostOf = (endpoint: string) => new URL(endpoint).host

/**
 * Sends Web Push messages in the background. `send` returns at once; delivery, 404/410 cleanup and
 * failure counting happen afterwards and never throw into the caller.
 */
export function createPushSender({ db, vapid, limiter, log, transport = fetchTransport, now = Date.now }: PushSenderOptions) {
  const signer = createVapidSigner(vapid, now)
  const inFlight = new Set<Promise<void>>()

  const deliver = async (userId: string, subscription: Subscription, payload: string) => {
    let status: number | null = null
    try {
      status = (await transport(await buildPushRequest(subscription, payload, signer, TTL_SEC))).status
    } catch (error) {
      log({ level: 'warn', event: 'push_failed', user: userId, host: hostOf(subscription.endpoint), error: error instanceof Error ? error.name : 'error' })
    }
    if (status !== null && status >= 200 && status < 300) return markDelivered(db, userId, subscription.id, now())
    if (status === 404 || status === 410) {
      removeSubscription(db, userId, subscription.id)
      log({ level: 'info', event: 'push_expired', user: userId, host: hostOf(subscription.endpoint), status })
      return
    }
    if (status !== null) log({ level: 'warn', event: 'push_failed', user: userId, host: hostOf(subscription.endpoint), status })
    if ((recordFailure(db, userId, subscription.id) ?? 0) >= MAX_FAILURES) removeSubscription(db, userId, subscription.id)
  }

  const run = async (userId: string, message: PushMessage, exceptTokenId: string | null) => {
    const subscriptions = subscriptionsFor(db, userId, message.type, exceptTokenId)
    if (subscriptions.length === 0) return
    if (limiter.take(userId) !== null) {
      log({ level: 'warn', event: 'push_rate_limited', user: userId })
      return
    }
    const payload = JSON.stringify({ title: message.title, body: message.body, url: message.url, tag: message.tag })
    await Promise.all(subscriptions.map((subscription) => deliver(userId, subscription, payload)))
  }

  return {
    publicKey: vapid.publicKey,

    /** Pushes `message` to the user's devices that want its type, except the device session `exceptTokenId`. */
    send(userId: string, message: PushMessage, exceptTokenId: string | null = null): void {
      const task = Promise.resolve()
        .then(() => run(userId, message, exceptTokenId))
        .catch((error: unknown) => log({ level: 'error', event: 'push_error', user: userId, error: error instanceof Error ? error.message : 'error' }))
        .finally(() => inFlight.delete(task))
      inFlight.add(task)
    },

    /** Resolves once every send started so far has finished; for tests and shutdown. */
    async idle(): Promise<void> {
      while (inFlight.size) await Promise.all(inFlight)
    },
  }
}

export type PushSender = ReturnType<typeof createPushSender>
