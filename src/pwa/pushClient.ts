import { apiRequest } from '../sync/api'
import { syncController } from '../sync/client'
import { presencePrefs } from './presencePrefs'
import { PushController, type PushDeps, type PushManagerLike } from './push'

/** Whether this browser has Web Push at all (Safari only inside an installed app). */
export const pushSupported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof PushManager !== 'undefined'

let serverKey: Promise<string | null> | null = null

/** The server's VAPID key, fetched once per page; null when the server has push off. */
export function pushServerKey(): Promise<string | null> {
  serverKey ??= apiRequest<{ publicKey: string | null }>({ baseUrl: '', fetch: (...args) => fetch(...args) }, 'GET', '/api/push/key')
    .then((reply) => reply.publicKey)
    .catch(() => {
      serverKey = null
      return null
    })
  return serverKey
}

/** The registration's push manager once its worker is active; null without a service worker (dev builds have none). */
async function pushManager(timeoutMs = 10_000): Promise<PushManagerLike | null> {
  if (!pushSupported()) return null
  const registration = await navigator.serviceWorker.getRegistration()
  if (!registration) return null
  if (registration.active) return registration.pushManager
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
  return (await Promise.race([navigator.serviceWorker.ready, timeout]))?.pushManager ?? null
}

const deps: PushDeps = {
  pushManager: () => pushManager(),
  serverKey: pushServerKey,
  request: (method, path, body) => syncController.request(method, path, body),
}

const signedIn = {
  subscribe: syncController.subscribe,
  getSnapshot: () => syncController.getSnapshot().auth === 'signedIn',
}

export const pushController = new PushController(deps, presencePrefs, signedIn)

/** Keeps this device's push subscription in step with its prefs, and ends it on sign-out. */
export function startPush(): () => void {
  const stopFollowing = pushController.follow((error) => console.warn('Could not register for push', error))
  const stopHook = syncController.onSignOut(() => pushController.disable())
  return () => {
    stopFollowing()
    stopHook()
  }
}
