import { afterEach, describe, expect, it } from 'bun:test'
import type { WireChange } from '../shared/sync'
import { createChannelRegistry, type ChannelOwner, type Registration } from './channel/registry'
import { record } from './fixtures'
import { DEFAULT_RATE_LIMITS, type RateSpec } from './limits'
import type { LogEntry } from './log'
import type { InboxRecord } from './mcp/records'
import { newReviewRequests } from './push/inbox'
import { MAX_FAILURES } from './push/sender'
import { listSubscriptions, MAX_SUBSCRIPTIONS, type PushPrefs } from './push/store'
import { decryptPush, fakeTransport, receiverKeys, TEST_VAPID, type Receiver } from './push/testing'
import type { PushRequest } from './push/webPush'
import { adminLogin, createUserSession, makeApp, request } from './testing'

const ORIGIN = 'https://ducky.example'
const ALL: PushPrefs = { tasks: true, requests: true }

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

const subscriptionBody = ({ target }: Receiver, prefs: PushPrefs = ALL) => ({
  subscription: { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
  prefs,
})

function setup({ status = () => 201, push, vapid = true }: { status?: (request: PushRequest) => number; push?: RateSpec; vapid?: boolean } = {}) {
  const transport = fakeTransport(status)
  const logs: LogEntry[] = []
  const made = makeApp({
    channel: createChannelRegistry(),
    publicUrl: ORIGIN,
    vapid: vapid ? TEST_VAPID : undefined,
    pushTransport: transport.transport,
    limits: { ...DEFAULT_RATE_LIMITS, ...(push ? { push } : {}) },
    log: (entry) => logs.push(entry),
  })
  cleanups.push(made.cleanup)
  const send = (method: string, path: string, token?: string, body?: unknown) => request(made.app, method, path, body, token)
  const subscribe = async (token: string, prefs: PushPrefs = ALL) => {
    const receiver = await receiverKeys()
    const res = await send('POST', '/api/push/subscriptions', token, subscriptionBody(receiver, prefs))
    expect(res.status).toBe(201)
    return receiver
  }
  /** The decrypted payloads delivered to `receiver`. */
  const received = async (receiver: Receiver) => {
    await made.push?.idle()
    const mine = transport.sent.filter((sent) => sent.endpoint === receiver.target.endpoint)
    return Promise.all(mine.map(async (sent) => JSON.parse(await decryptPush(receiver, sent.body)) as Record<string, string>))
  }
  return { ...made, transport, logs, send, subscribe, received }
}

const registration: Registration = {
  id: 'plugin-session-0001',
  label: 'ledger on laptop',
  cwd: '/src/ledger',
  repo: 'alice/ledger',
  branch: 'feature/tax',
  hostname: 'laptop',
  pluginVersion: '0.1.0',
}

/** Sends a task to a fresh plugin session of the user's and has Claude report `state` with a message. */
function finishTask(ctx: ReturnType<typeof setup>, userId: string, state: 'done' | 'failed', sessionId: string | null = 's1') {
  const owner: ChannelOwner = { userId, tokenId: `plugin-${userId}`, grantId: null, tokenName: 'Claude' }
  ctx.channel.connect(registration, owner, () => true)
  const task = ctx.channel.sendTask(userId, registration.id, {
    kind: 'fix',
    repo: 'alice/ledger',
    branch: 'feature/tax',
    pr: null,
    sessionId,
    content: 'Fix it',
    meta: {},
  })
  if (typeof task === 'string') throw new Error(task)
  expect(ctx.channel.report(registration.id, owner, task.id, state, 'Fixed the secret note about card numbers')).toBe(true)
  return task
}

const inbox = (fetchedAt: number, ...numbers: number[]): WireChange =>
  record(
    'inbox',
    'inbox',
    {
      fetchedAt,
      items: numbers.map((number) => ({
        repo: 'acme/web',
        number,
        title: `PR ${number}`,
        author: 'octo',
        url: `https://github.com/acme/web/pull/${number}`,
        updatedAt: 'x',
        section: 'requested',
      })),
    },
    fetchedAt,
  )

const pushSync = (ctx: ReturnType<typeof setup>, token: string, ...changes: WireChange[]) =>
  ctx.send('POST', '/api/sync', token, { cursor: 0, changes })

describe('push subscription routes', () => {
  it('hands out the VAPID public key, or null when push is off', async () => {
    expect(await (await setup().send('GET', '/api/push/key')).json()).toEqual({ publicKey: TEST_VAPID.publicKey })
    const off = setup({ vapid: false })
    expect(await (await off.send('GET', '/api/push/key')).json()).toEqual({ publicKey: null })
    const alice = createUserSession(off.db, 'alice')
    const res = await off.send('POST', '/api/push/subscriptions', alice.token, subscriptionBody(await receiverKeys()))
    expect(res.status).toBe(404)
    expect(off.push).toBeNull()
  })

  it('needs a device session', async () => {
    const ctx = setup()
    const alice = createUserSession(ctx.db, 'alice')
    const api = (await (await ctx.send('POST', '/api/auth/tokens', alice.token, { name: 'Claude' })).json()) as { token: string }
    const body = subscriptionBody(await receiverKeys())
    expect((await ctx.send('POST', '/api/push/subscriptions', undefined, body)).status).toBe(401)
    expect((await ctx.send('POST', '/api/push/subscriptions', api.token, body)).status).toBe(403)
    expect((await ctx.send('DELETE', '/api/push/subscriptions', api.token, { endpoint: body.subscription.endpoint })).status).toBe(403)
  })

  it('refuses endpoints outside the browsers\' push services and malformed keys', async () => {
    const ctx = setup()
    const alice = createUserSession(ctx.db, 'alice')
    const receiver = await receiverKeys()
    const post = (body: unknown) => ctx.send('POST', '/api/push/subscriptions', alice.token, body)
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://fcm.googleapis.com:8443/fcm/send/x',
      'https://evil.example/fcm.googleapis.com',
      'https://notfcm.googleapis.com.evil.example/x',
      'https://127.0.0.1/x',
      `https://fcm.googleapis.com/${'x'.repeat(2048)}`,
    ]) {
      expect((await post(subscriptionBody({ ...receiver, target: { ...receiver.target, endpoint } }))).status, endpoint).toBe(400)
    }
    expect((await post(subscriptionBody({ ...receiver, target: { ...receiver.target, p256dh: receiver.target.auth } }))).status).toBe(400)
    expect((await post(subscriptionBody({ ...receiver, target: { ...receiver.target, auth: 'short' } }))).status).toBe(400)
    expect((await post({ subscription: subscriptionBody(receiver).subscription })).status).toBe(400)
    for (const endpoint of ['https://web.push.apple.com/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://wns2-par02p.notify.windows.com/w/?token=abc']) {
      expect((await post(subscriptionBody({ ...receiver, target: { ...receiver.target, endpoint } }))).status, endpoint).toBe(201)
    }
  })

  it('registers, updates the prefs of, and drops a device\'s subscription', async () => {
    const ctx = setup()
    const alice = createUserSession(ctx.db, 'alice')
    const receiver = await ctx.subscribe(alice.token)
    const update = await ctx.send('POST', '/api/push/subscriptions', alice.token, subscriptionBody(receiver, { tasks: false, requests: true }))
    expect(update.status).toBe(200)
    expect(listSubscriptions(ctx.db, alice.user.id)).toMatchObject([{ endpoint: receiver.target.endpoint, prefs: { tasks: false, requests: true }, failures: 0 }])
    expect((await ctx.send('DELETE', '/api/push/subscriptions', alice.token, { endpoint: receiver.target.endpoint })).status).toBe(200)
    expect(listSubscriptions(ctx.db, alice.user.id)).toEqual([])
    expect((await ctx.send('DELETE', '/api/push/subscriptions', alice.token, { endpoint: receiver.target.endpoint })).status).toBe(404)
  })

  it('keeps another user\'s subscription out of reach', async () => {
    const ctx = setup()
    const alice = createUserSession(ctx.db, 'alice')
    const bob = createUserSession(ctx.db, 'bob')
    const receiver = await ctx.subscribe(alice.token)
    expect((await ctx.send('DELETE', '/api/push/subscriptions', bob.token, { endpoint: receiver.target.endpoint })).status).toBe(404)
    const taken = await ctx.send('POST', '/api/push/subscriptions', bob.token, subscriptionBody(receiver, { tasks: false, requests: false }))
    expect(taken.status).toBe(409)
    expect(await taken.json()).toEqual({ error: 'endpoint_taken' })
    expect(listSubscriptions(ctx.db, alice.user.id)).toMatchObject([{ endpoint: receiver.target.endpoint, prefs: ALL }])
    expect(listSubscriptions(ctx.db, bob.user.id)).toEqual([])
  })

  it(`keeps at most ${MAX_SUBSCRIPTIONS} per user, dropping the least recently used`, async () => {
    const ctx = setup()
    const alice = createUserSession(ctx.db, 'alice')
    const first = await ctx.subscribe(alice.token)
    for (let i = 1; i < MAX_SUBSCRIPTIONS; i++) await ctx.subscribe(alice.token)
    const used = listSubscriptions(ctx.db, alice.user.id)
    expect(used).toHaveLength(MAX_SUBSCRIPTIONS)
    ctx.db.query('UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?').run(Date.now() + 60_000, first.target.endpoint)
    await ctx.subscribe(alice.token)
    const after = listSubscriptions(ctx.db, alice.user.id).map((s) => s.endpoint)
    expect(after).toHaveLength(MAX_SUBSCRIPTIONS)
    expect(after).toContain(first.target.endpoint)
    expect(after).not.toContain(used[1]!.endpoint)
  })
})

describe('subscriptions end with the device or the account', () => {
  it('signing the device out drops its subscription and keeps the other device\'s', async () => {
    const ctx = setup()
    const laptop = createUserSession(ctx.db, 'alice', 'Laptop')
    const phone = createUserSession(ctx.db, 'alice', 'Phone')
    await ctx.subscribe(laptop.token)
    const kept = await ctx.subscribe(phone.token)
    expect((await ctx.send('POST', '/api/auth/logout', laptop.token)).status).toBe(200)
    expect(listSubscriptions(ctx.db, laptop.user.id).map((s) => s.endpoint)).toEqual([kept.target.endpoint])
  })

  it('admin disable and delete, and account delete, remove the user\'s subscriptions only', async () => {
    const ctx = setup()
    const admin = await adminLogin(ctx.app)
    const alice = createUserSession(ctx.db, 'alice')
    const bob = createUserSession(ctx.db, 'bob')
    const carol = createUserSession(ctx.db, 'carol')
    const dave = createUserSession(ctx.db, 'dave')
    for (const user of [alice, bob, carol, dave]) await ctx.subscribe(user.token)

    expect((await ctx.send('POST', `/api/admin/users/${bob.user.id}/disable`, admin.token)).status).toBe(200)
    expect(listSubscriptions(ctx.db, bob.user.id)).toEqual([])
    expect((await ctx.send('DELETE', `/api/admin/users/${carol.user.id}`, admin.token)).status).toBe(200)
    expect(listSubscriptions(ctx.db, carol.user.id)).toEqual([])
    expect((await ctx.send('DELETE', '/api/account', dave.token, { confirm: 'dave' })).status).toBe(200)
    expect(listSubscriptions(ctx.db, dave.user.id)).toEqual([])
    expect(ctx.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM push_subscriptions').get()!.n).toBe(1)
    expect(listSubscriptions(ctx.db, alice.user.id)).toHaveLength(1)
  })
})

describe('pushes for finished Claude tasks', () => {
  it('sends a small payload with the session URL, never Claude\'s message', async () => {
    const ctx = setup()
    const alice = createUserSession(ctx.db, 'alice')
    const receiver = await ctx.subscribe(alice.token)
    const task = finishTask(ctx, alice.user.id, 'done')
    const [payload, ...rest] = await ctx.received(receiver)
    expect(rest).toEqual([])
    expect(payload).toEqual({
      title: 'Claude finished the fix',
      body: 'alice/ledger · feature/tax',
      url: `${ORIGIN}/sessions/s1`,
      tag: `task:${task.id}:done`,
    })
    const sent = ctx.transport.sent[0]!
    expect(sent.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', TTL: '86400' })
    expect(sent.headers.Authorization).toStartWith('vapid t=')
    expect(new TextDecoder().decode(sent.body)).not.toContain('Fixed')
    expect(listSubscriptions(ctx.db, alice.user.id)[0]!.lastUsedAt).not.toBeNull()
  })

  it('pushes a failure too, and only to subscriptions that want tasks', async () => {
    const ctx = setup()
    const alice = createUserSession(ctx.db, 'alice', 'Laptop')
    const phone = createUserSession(ctx.db, 'alice', 'Phone')
    const wants = await ctx.subscribe(alice.token)
    const quiet = await ctx.subscribe(phone.token, { tasks: false, requests: true })
    finishTask(ctx, alice.user.id, 'failed', null)
    expect(await ctx.received(wants)).toMatchObject([{ title: "Claude's fix failed", url: `${ORIGIN}/` }])
    expect(await ctx.received(quiet)).toEqual([])
  })

  it('never pushes one user\'s events to another', async () => {
    const ctx = setup()
    const alice = createUserSession(ctx.db, 'alice')
    const bob = createUserSession(ctx.db, 'bob')
    const aliceDevice = await ctx.subscribe(alice.token)
    const bobDevice = await ctx.subscribe(bob.token)
    finishTask(ctx, alice.user.id, 'done')
    expect((await pushSync(ctx, alice.token, inbox(1, 1))).status).toBe(200)
    expect((await pushSync(ctx, createUserSession(ctx.db, 'alice', 'Desktop').token, inbox(2, 1, 2))).status).toBe(200)
    expect(await ctx.received(aliceDevice)).toHaveLength(2)
    expect(await ctx.received(bobDevice)).toEqual([])
  })

  it('drops a subscription the push service says is gone', async () => {
    for (const status of [404, 410]) {
      const ctx = setup({ status: () => status })
      const alice = createUserSession(ctx.db, 'alice')
      await ctx.subscribe(alice.token)
      finishTask(ctx, alice.user.id, 'done')
      await ctx.push!.idle()
      expect(listSubscriptions(ctx.db, alice.user.id)).toEqual([])
      expect(ctx.logs).toContainEqual(expect.objectContaining({ event: 'push_expired', status, host: 'fcm.googleapis.com' }))
    }
  })

  it('counts other failures and drops the subscription after several in a row, logging no secrets', async () => {
    let status = 500
    const ctx = setup({ status: () => status })
    const alice = createUserSession(ctx.db, 'alice')
    const receiver = await ctx.subscribe(alice.token)
    finishTask(ctx, alice.user.id, 'done')
    await ctx.push!.idle()
    expect(listSubscriptions(ctx.db, alice.user.id)[0]!.failures).toBe(1)
    status = 201
    finishTask(ctx, alice.user.id, 'done')
    await ctx.push!.idle()
    expect(listSubscriptions(ctx.db, alice.user.id)[0]!.failures).toBe(0)
    status = 503
    for (let i = 0; i < MAX_FAILURES; i++) finishTask(ctx, alice.user.id, 'done')
    await ctx.push!.idle()
    expect(listSubscriptions(ctx.db, alice.user.id)).toEqual([])
    const logged = JSON.stringify(ctx.logs)
    expect(logged).toContain('push_failed')
    for (const secret of [new URL(receiver.target.endpoint).pathname, receiver.target.auth, receiver.target.p256dh, TEST_VAPID.privateKey]) {
      expect(logged).not.toContain(secret)
    }
  })

  it('survives a push service that cannot be reached', async () => {
    const ctx = setup({
      status: () => {
        throw new TypeError('fetch failed')
      },
    })
    const alice = createUserSession(ctx.db, 'alice')
    await ctx.subscribe(alice.token)
    finishTask(ctx, alice.user.id, 'done')
    await ctx.push!.idle()
    expect(listSubscriptions(ctx.db, alice.user.id)[0]!.failures).toBe(1)
    expect(ctx.logs).toContainEqual(expect.objectContaining({ event: 'push_failed', error: 'TypeError' }))
  })

  it('rate-limits pushes per user', async () => {
    const ctx = setup({ push: { limit: 2, windowSec: 3600, burst: 2 } })
    const alice = createUserSession(ctx.db, 'alice')
    const bob = createUserSession(ctx.db, 'bob')
    const aliceDevice = await ctx.subscribe(alice.token)
    const bobDevice = await ctx.subscribe(bob.token)
    for (let i = 0; i < 4; i++) finishTask(ctx, alice.user.id, 'done')
    finishTask(ctx, bob.user.id, 'done')
    expect(await ctx.received(aliceDevice)).toHaveLength(2)
    expect(await ctx.received(bobDevice)).toHaveLength(1)
    expect(ctx.logs.filter((entry) => entry.event === 'push_rate_limited')).toEqual([
      { level: 'warn', event: 'push_rate_limited', user: alice.user.id },
      { level: 'warn', event: 'push_rate_limited', user: alice.user.id },
    ])
  })
})

describe('pushes for new review requests', () => {
  it('notifies the user\'s other devices when a sync adds requests, but not the device that synced', async () => {
    const ctx = setup()
    const laptop = createUserSession(ctx.db, 'alice', 'Laptop')
    const phone = createUserSession(ctx.db, 'alice', 'Phone')
    const laptopDevice = await ctx.subscribe(laptop.token)
    const phoneDevice = await ctx.subscribe(phone.token)

    await pushSync(ctx, laptop.token, inbox(1, 1, 2))
    expect(await ctx.received(phoneDevice)).toEqual([])

    await pushSync(ctx, laptop.token, inbox(2, 1, 2, 3))
    expect(await ctx.received(phoneDevice)).toEqual([
      { title: 'Review requested: acme/web#3', body: 'PR 3 (@octo)', url: `${ORIGIN}/pr/acme/web/3`, tag: 'review-request:https://github.com/acme/web/pull/3' },
    ])
    expect(await ctx.received(laptopDevice)).toEqual([])

    await pushSync(ctx, phone.token, inbox(3, 3, 4, 5))
    expect(await ctx.received(laptopDevice)).toEqual([
      { title: '2 new review requests', body: 'acme/web#4, acme/web#5', url: `${ORIGIN}/inbox`, tag: 'review-requests' },
    ])
    expect(await ctx.received(phoneDevice)).toHaveLength(1)
  })

  it('stays quiet when the inbox is unchanged, older than the stored one, or turned off for a device', async () => {
    const ctx = setup()
    const laptop = createUserSession(ctx.db, 'alice', 'Laptop')
    const phone = createUserSession(ctx.db, 'alice', 'Phone')
    const quiet = await ctx.subscribe(phone.token, { tasks: true, requests: false })
    await pushSync(ctx, laptop.token, inbox(5, 1))
    await pushSync(ctx, laptop.token, inbox(6, 1))
    await pushSync(ctx, laptop.token, inbox(4, 1, 9))
    await pushSync(ctx, laptop.token, inbox(7, 1, 2))
    expect(await ctx.received(quiet)).toEqual([])
    expect(ctx.transport.sent).toEqual([])
  })

  it('notifies every device when an API token syncs the inbox', async () => {
    const ctx = setup()
    const laptop = createUserSession(ctx.db, 'alice', 'Laptop')
    const device = await ctx.subscribe(laptop.token)
    const api = (await (await ctx.send('POST', '/api/auth/tokens', laptop.token, { name: 'script' })).json()) as { token: string }
    await pushSync(ctx, api.token, inbox(1, 1))
    await pushSync(ctx, api.token, inbox(2, 1, 2))
    expect(await ctx.received(device)).toMatchObject([{ title: 'Review requested: acme/web#2' }])
  })
})

describe('new review requests rule', () => {
  const box = (...items: [number, string][]): InboxRecord => ({
    id: 'inbox',
    fetchedAt: 1,
    items: items.map(([number, section]) => ({ repo: 'a/b', number, title: 't', author: 'o', url: `u${number}`, updatedAt: 'x', section })),
  })

  it('reports requested items not requested before, once each', () => {
    expect(newReviewRequests(box([1, 'requested']), box([1, 'requested'], [2, 'requested'], [2, 'requested'])).map((i) => i.number)).toEqual([2])
  })

  it('counts an item moving into the requested section', () => {
    expect(newReviewRequests(box([1, 'mine']), box([1, 'requested'])).map((i) => i.number)).toEqual([1])
  })

  it('ignores other sections, removals and a first inbox', () => {
    expect(newReviewRequests(box([1, 'requested']), box([2, 'mine']))).toEqual([])
    expect(newReviewRequests(null, box([1, 'requested']))).toEqual([])
    expect(newReviewRequests(box([1, 'requested']), null)).toEqual([])
  })
})
