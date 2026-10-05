import type { Database } from 'bun:sqlite'
import { Hono, type Context } from 'hono'
import { requireToken, type AuthEnv } from '../auth/middleware'
import type { TokenStore } from '../auth/tokens'
import { deleteSubscription, saveSubscription, type PushPrefs } from './store'
import { validAuthSecret, validPublicKey, type PushTarget } from './webPush'

export interface PushRoutesOptions {
  db: Database
  tokens: TokenStore
  /** The VAPID public key; unset when Web Push is not configured. */
  publicKey?: string
}

/**
 * Hosts of the browsers' push services. The server POSTs to a subscription's endpoint, so endpoints
 * elsewhere are refused rather than letting a user point the server at an arbitrary URL.
 */
const PUSH_SERVICE_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com', 'push.apple.com']

const MAX_ENDPOINT = 2048

export function validEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_ENDPOINT) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return false
  return PUSH_SERVICE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** `subscription.toJSON()` from the browser, plus this device's per-type choices. */
export function parseSubscription(body: unknown): { target: PushTarget; prefs: PushPrefs } | null {
  if (!isObject(body) || !isObject(body.subscription) || !isObject(body.prefs)) return null
  const { endpoint, keys } = body.subscription
  const { tasks, requests } = body.prefs
  if (!validEndpoint(endpoint) || !isObject(keys) || typeof tasks !== 'boolean' || typeof requests !== 'boolean') return null
  const { p256dh, auth } = keys
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !validPublicKey(p256dh) || !validAuthSecret(auth)) return null
  return { target: { endpoint, p256dh, auth }, prefs: { tasks, requests } }
}

/** Routes under /api/push: the VAPID key, and a device registering or dropping its push subscription. */
export function pushRoutes({ db, tokens, publicKey }: PushRoutesOptions) {
  const routes = new Hono<AuthEnv>()
  const session = requireToken(tokens, ['session'])
  const body = (c: Context) => c.req.json().catch(() => null)

  routes.get('/key', (c) => c.json({ publicKey: publicKey ?? null }))

  routes.post('/subscriptions', session, async (c) => {
    if (!publicKey) return c.json({ error: 'push_disabled' }, 404)
    const parsed = parseSubscription(await body(c))
    if (!parsed) return c.json({ error: 'invalid_subscription' }, 400)
    const { userId, id } = c.get('principal')
    const result = saveSubscription(db, userId, id, parsed.target, parsed.prefs)
    if (result === 'taken') return c.json({ error: 'endpoint_taken' }, 409)
    return c.json({ ok: true }, result === 'created' ? 201 : 200)
  })

  routes.delete('/subscriptions', session, async (c) => {
    const endpoint = ((await body(c)) as { endpoint?: unknown } | null)?.endpoint
    if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT) return c.json({ error: 'invalid_endpoint' }, 400)
    return deleteSubscription(db, c.get('principal').userId, endpoint) ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404)
  })

  return routes
}
