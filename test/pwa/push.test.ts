import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PREFS, PresencePrefsStore, prefsOf, type PresencePrefs } from '../../src/pwa/presencePrefs'
import { decodeKey, PushController, PushUnavailableError, subscribePush, unsubscribePush, type PushDeps, type PushManagerLike, type PushSubscriptionLike } from '../../src/pwa/push'
import { HttpError } from '../../src/sync/api'

const KEY = 'BO5YUxHrmBsgbxebAao2TZal1Lih0RA-OY4Uea80Kmi7glZfTUPmO5SjHcWKJADYH8-Q_xwjpyC0B2vfxYllS9o'
const OTHER_KEY = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A browser push manager holding at most one subscription, as a real one does per service worker. */
function fakeManager() {
  let count = 0
  let current: PushSubscriptionLike | null = null
  const manager: PushManagerLike & { subscribed: number } = {
    subscribed: 0,
    getSubscription: async () => current,
    subscribe: vi.fn(async ({ applicationServerKey }) => {
      if (current) return current
      manager.subscribed++
      const endpoint = `https://fcm.googleapis.com/fcm/send/${++count}`
      const subscription: PushSubscriptionLike = {
        endpoint,
        options: { applicationServerKey: applicationServerKey.slice().buffer },
        toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
        unsubscribe: async () => {
          if (current === subscription) current = null
          return true
        },
      }
      current = subscription
      return subscription
    }),
  }
  return { manager, current: () => current }
}

function setup({ key = KEY as string | null, manager = fakeManager() as ReturnType<typeof fakeManager> | null } = {}) {
  const calls: { method: string; path: string; body: unknown }[] = []
  const reply = { taken: 0 }
  const deps: PushDeps = {
    pushManager: async () => manager?.manager ?? null,
    serverKey: async () => key,
    request: async (method, path, body) => {
      calls.push({ method, path, body })
      if (method === 'POST' && reply.taken > 0) {
        reply.taken--
        throw new HttpError(409, 'endpoint_taken')
      }
      return { ok: true }
    },
  }
  return { deps, calls, reply, manager }
}

function prefsStore(prefs: Partial<PresencePrefs> = {}) {
  return new PresencePrefsStore({ read: () => ({ ...DEFAULT_PREFS, notifications: true, ...prefs }), write: () => undefined })
}

function flag(initial: boolean) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    getSnapshot: () => value,
    set(next: boolean) {
      value = next
      listeners.forEach((listener) => listener())
    },
  }
}

const posts = (calls: { method: string; body: unknown }[]) => calls.filter((call) => call.method === 'POST').map((call) => call.body)

describe('push prefs', () => {
  it('default to off and keep a stored choice', () => {
    expect(prefsOf(null).push).toBe(false)
    expect(prefsOf({ push: true }).push).toBe(true)
    expect(prefsOf({ push: 'yes' }).push).toBe(false)
  })
})

describe('subscribePush', () => {
  it('subscribes with the server key and registers the subscription with the per-type choices', async () => {
    const { deps, calls, manager } = setup()
    await subscribePush(deps, { tasks: true, requests: false })
    expect(manager!.manager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: decodeKey(KEY) })
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/push/subscriptions',
        body: { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/1', keys: { p256dh: 'p', auth: 'a' } }, prefs: { tasks: true, requests: false } },
      },
    ])
  })

  it('reuses the browser\'s subscription, and replaces one made for another server key', async () => {
    const { deps, manager } = setup()
    await subscribePush(deps, { tasks: true, requests: true })
    await subscribePush(deps, { tasks: false, requests: true })
    expect(manager!.manager.subscribed).toBe(1)
    const rotated = setup({ key: OTHER_KEY, manager })
    await subscribePush(rotated.deps, { tasks: true, requests: true })
    expect(manager!.manager.subscribed).toBe(2)
    expect(new Uint8Array(manager!.current()!.options.applicationServerKey!)).toEqual(decodeKey(OTHER_KEY))
  })

  it('starts over with a new endpoint when another account holds this one', async () => {
    const { deps, calls, reply, manager } = setup()
    reply.taken = 1
    await subscribePush(deps, { tasks: true, requests: true })
    const endpoints = posts(calls).map((body) => (body as { subscription: { endpoint: string } }).subscription.endpoint)
    expect(endpoints).toEqual(['https://fcm.googleapis.com/fcm/send/1', 'https://fcm.googleapis.com/fcm/send/2'])
    expect(manager!.current()!.endpoint).toBe('https://fcm.googleapis.com/fcm/send/2')
  })

  it('says why push is unavailable', async () => {
    await expect(subscribePush(setup({ manager: null }).deps, { tasks: true, requests: true })).rejects.toThrow(PushUnavailableError)
    await expect(subscribePush(setup({ key: null }).deps, { tasks: true, requests: true })).rejects.toThrow('server has push turned off')
  })
})

describe('unsubscribePush', () => {
  it('removes the subscription from the server and the browser, even when the server cannot be reached', async () => {
    const { deps, calls, manager } = setup()
    await subscribePush(deps, { tasks: true, requests: true })
    await unsubscribePush({ ...deps, request: async (...args) => (await deps.request(...args), Promise.reject(new Error('offline'))) })
    expect(calls.at(-1)).toEqual({ method: 'DELETE', path: '/api/push/subscriptions', body: { endpoint: 'https://fcm.googleapis.com/fcm/send/1' } })
    expect(manager!.current()).toBeNull()
  })

  it('does nothing without a subscription', async () => {
    const { deps, calls } = setup()
    await unsubscribePush(deps)
    expect(calls).toEqual([])
  })
})

describe('PushController', () => {
  it('turning on registers once and remembers the choice; turning off unsubscribes', async () => {
    const { deps, calls, manager } = setup()
    const prefs = prefsStore()
    const controller = new PushController(deps, prefs, flag(true))
    const stop = controller.follow(() => undefined)
    await controller.enable()
    await settle()
    expect(prefs.getSnapshot().push).toBe(true)
    expect(posts(calls)).toHaveLength(1)
    await controller.disable()
    expect(prefs.getSnapshot().push).toBe(false)
    expect(manager!.current()).toBeNull()
    expect(calls.at(-1)?.method).toBe('DELETE')
    stop()
  })

  it('leaves the choice off when subscribing fails', async () => {
    const prefs = prefsStore()
    const controller = new PushController(setup({ key: null }).deps, prefs, flag(true))
    await expect(controller.enable()).rejects.toThrow(PushUnavailableError)
    expect(prefs.getSnapshot().push).toBe(false)
  })

  it('registers again when the per-type choices change, and on each sign-in', async () => {
    const { deps, calls } = setup()
    const prefs = prefsStore({ push: true })
    const signedIn = flag(false)
    const stop = new PushController(deps, prefs, signedIn).follow(() => undefined)
    await settle()
    expect(calls).toEqual([])
    signedIn.set(true)
    await settle()
    prefs.update({ notifyRequests: false })
    await settle()
    prefs.update({ badge: 'off' })
    await settle()
    signedIn.set(false)
    signedIn.set(true)
    await settle()
    expect(posts(calls).map((body) => (body as { prefs: unknown }).prefs)).toEqual([
      { tasks: true, requests: true },
      { tasks: true, requests: false },
      { tasks: true, requests: false },
    ])
    stop()
    prefs.update({ notifyTasks: false })
    await settle()
    expect(posts(calls)).toHaveLength(3)
  })

  it('stays quiet while notifications or push are off', async () => {
    const { deps, calls } = setup()
    const prefs = prefsStore({ push: true, notifications: false })
    const stop = new PushController(deps, prefs, flag(true)).follow(() => undefined)
    prefs.update({ notifyTasks: false })
    prefs.update({ notifications: true, push: false })
    await settle()
    expect(calls).toEqual([])
    stop()
  })

  it('reports a failed registration', async () => {
    const onError = vi.fn()
    const stop = new PushController(setup({ manager: null }).deps, prefsStore({ push: true }), flag(true)).follow(onError)
    await settle()
    expect(onError).toHaveBeenCalledWith(expect.any(PushUnavailableError))
    stop()
  })
})
