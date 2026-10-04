import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { createRateLimiter, DEFAULT_RATE_LIMITS, loadRateLimits, rateLimit, type RateLimits } from './limits'
import { createUserSession, makeApp, request } from './testing'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

function clock() {
  let at = 1_000_000
  return { now: () => at, advance: (ms: number) => (at += ms) }
}

describe('createRateLimiter', () => {
  it('allows a burst, then refills at the steady rate', () => {
    const time = clock()
    const limiter = createRateLimiter({ capacity: 3, refillPerSec: 0.5, now: time.now })
    expect([limiter.take('a'), limiter.take('a'), limiter.take('a')]).toEqual([null, null, null])
    expect(limiter.take('a')).toBe(2)
    time.advance(1000)
    expect(limiter.take('a')).toBe(1)
    time.advance(1000)
    expect(limiter.take('a')).toBeNull()
    expect(limiter.take('a')).toBe(2)
  })

  it('keeps a bucket per key and never refills past capacity', () => {
    const time = clock()
    const limiter = createRateLimiter({ capacity: 1, refillPerSec: 1, now: time.now })
    expect(limiter.take('a')).toBeNull()
    expect(limiter.take('a')).toBe(1)
    expect(limiter.take('b')).toBeNull()
    time.advance(60_000)
    expect(limiter.take('a')).toBeNull()
    expect(limiter.take('a')).toBe(1)
  })

  it('drops refilled buckets once it holds too many keys', () => {
    const time = clock()
    const limiter = createRateLimiter({ capacity: 1, refillPerSec: 1, now: time.now, maxKeys: 2 })
    limiter.take('a')
    limiter.take('b')
    time.advance(5_000)
    expect(limiter.take('c')).toBeNull()
    expect(limiter.take('a')).toBeNull()
  })
})

describe('rateLimit middleware', () => {
  it('answers 429 with Retry-After once the key is out of tokens', async () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerSec: 0.1, now: clock().now })
    const app = new Hono()
    app.get('/', rateLimit(limiter, (c) => c.req.header('x-user') ?? ''), (c) => c.json({ ok: true }))
    const get = (user: string) => app.request('/', { headers: { 'x-user': user } })

    expect((await get('alice')).status).toBe(200)
    const limited = await get('alice')
    expect(limited.status).toBe(429)
    expect(limited.headers.get('Retry-After')).toBe('10')
    expect(await limited.json()).toEqual({ error: 'rate_limited' })
    expect((await get('bob')).status).toBe(200)
  })
})

describe('loadRateLimits', () => {
  it('uses the defaults, and scales the burst with an override', () => {
    expect(loadRateLimits({})).toEqual(DEFAULT_RATE_LIMITS)
    const limits = loadRateLimits({ CODEDUCKY_RATE_SYNC: '240', CODEDUCKY_RATE_NEW_ACCOUNTS: '5' })
    expect(limits.sync).toEqual({ limit: 240, windowSec: 60, burst: 60 })
    expect(limits.newAccounts).toEqual({ limit: 5, windowSec: 3600, burst: 5 })
    expect(() => loadRateLimits({ CODEDUCKY_RATE_MCP: 'lots' })).toThrow('CODEDUCKY_RATE_MCP')
  })
})

/** Every limit at one request, so the second call from the same user is refused. */
const ONE: RateLimits = Object.fromEntries(
  Object.entries(DEFAULT_RATE_LIMITS).map(([name, spec]) => [name, { ...spec, limit: 1, burst: 1 }]),
) as RateLimits

describe('per-user limits on routes', () => {
  function setup() {
    const made = makeApp({ limits: ONE })
    cleanups.push(made.cleanup)
    const alice = createUserSession(made.db, 'alice')
    const bob = createUserSession(made.db, 'bob')
    const apiToken = (userId: string) => made.tokens.issue({ userId, name: 'cli', kind: 'api' }).token
    return { ...made, alice, bob, apiToken }
  }

  it('limits /api/sync per user', async () => {
    const { app, alice, bob } = setup()
    const sync = (token: string) => request(app, 'POST', '/api/sync', { cursor: 0, changes: [] }, token)
    expect((await sync(alice.token)).status).toBe(200)
    const limited = await sync(alice.token)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect((await sync(bob.token)).status).toBe(200)
  })

  it('limits /api/gate per user', async () => {
    const { app, alice, apiToken } = setup()
    const token = apiToken(alice.user.id)
    const gate = () => request(app, 'GET', '/api/gate?repo=a/b&branch=main', undefined, token)
    expect((await gate()).status).toBe(200)
    expect((await gate()).status).toBe(429)
  })

  it('limits /mcp per user', async () => {
    const { app, alice, bob, apiToken } = setup()
    const call = (token: string) =>
      app.request('/mcp', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      })
    const token = apiToken(alice.user.id)
    expect((await call(token)).status).not.toBe(429)
    expect((await call(token)).status).toBe(429)
    expect((await call(apiToken(bob.user.id))).status).not.toBe(429)
  })

  it('limits channel tasks per user', async () => {
    const { app, alice } = setup()
    const task = () =>
      request(app, 'POST', '/api/channel/sessions/nope/tasks', {}, alice.token)
    expect((await task()).status).not.toBe(429)
    expect((await task()).status).toBe(429)
  })
})

describe('body limits', () => {
  it('caps /api/sync at 8 MB, other /api routes at 64 KB, /mcp at 1 MB and /oauth at 16 KB', async () => {
    const made = makeApp()
    cleanups.push(made.cleanup)
    const post = (path: string, bytes: number) =>
      made.app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(bytes) }, body: 'x'.repeat(bytes) })
    expect((await post('/api/sync', 8 * 1024 * 1024 + 1)).status).toBe(413)
    expect((await post('/api/sync', 1024 * 1024)).status).not.toBe(413)
    expect((await post('/api/auth/login', 64 * 1024 + 1)).status).toBe(413)
    expect((await post('/mcp', 1024 * 1024 + 1)).status).toBe(413)
    expect((await post('/oauth/register', 16 * 1024 + 1)).status).toBe(413)
    expect((await post('/oauth/register', 1024)).status).not.toBe(413)
  })
})
