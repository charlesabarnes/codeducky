import { afterEach, describe, expect, it } from 'bun:test'
import { challengeFor, newVerifier } from '../test/support/fakeSignIn'
import type { IdentityProvider } from './auth/github'
import { GitHubError } from './auth/github'
import { DEFAULT_SIGNUPS } from './config'
import type { LogEntry } from './log'
import { createUserSession, makeApp, request, signInAs, TEST_ORIGIN } from './testing'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

const setup = (...args: Parameters<typeof makeApp>) => {
  const made = makeApp(...args)
  cleanups.push(made.cleanup)
  return made
}
type App = ReturnType<typeof makeApp>['app']

function redirectOf(res: Response): string {
  expect(res.status).toBe(302)
  return res.headers.get('location')!
}

/** One browser's view of the round-trip, step by step, so tests can tamper between steps. */
async function begin(app: App, verifier = newVerifier(), origin = TEST_ORIGIN) {
  const res = await app.request(`${origin}/api/auth/github/start?challenge=${challengeFor(verifier)}`)
  const setCookie = res.headers.get('set-cookie') ?? ''
  return { verifier, res, setCookie, cookie: setCookie.split(';')[0]!, authorize: new URL(redirectOf(res)) }
}

async function authorize(app: App, url: URL, params: Record<string, string>) {
  const next = new URL(url)
  for (const [key, value] of Object.entries(params)) next.searchParams.set(key, value)
  return new URL(redirectOf(await app.request(next.toString())))
}

async function callback(app: App, url: URL, cookie?: string) {
  const res = await app.request(url.toString(), { headers: cookie ? { Cookie: cookie } : {} })
  const to = redirectOf(res)
  expect(to.startsWith('/signin/callback#')).toBe(true)
  return { res, fragment: new URLSearchParams(to.split('#')[1]) }
}

async function roundTrip(app: App, login: string, extra: Record<string, string> = {}) {
  const flow = await begin(app)
  const back = await authorize(app, flow.authorize, { login, auto: '1', ...extra })
  return { ...flow, ...(await callback(app, back, flow.cookie)) }
}

const exchange = (app: App, body: Record<string, unknown>) => request(app, 'POST', '/api/auth/exchange', body)

describe('GitHub sign-in', () => {
  it('ties the round-trip to the browser with a short-lived HttpOnly cookie', async () => {
    const { app } = setup()
    const { setCookie, authorize: url } = await begin(app)
    expect(setCookie).toStartWith('rd_flow=')
    expect(setCookie).toContain('Path=/api/auth')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie).toContain('Max-Age=600')
    expect(setCookie).not.toContain('Secure')
    expect(url.pathname).toBe('/api/auth/fake-github/authorize')
    expect(url.searchParams.get('state')).toBeTruthy()
  })

  it('uses a __Secure- cookie and the public URL for the callback on https', async () => {
    const { app } = setup({ publicUrl: 'https://ducky.example' })
    const flow = await begin(app, undefined, 'http://internal:8787')
    expect(flow.setCookie).toStartWith('__Secure-rd_flow=')
    expect(flow.setCookie).toContain('Secure')
    expect(flow.authorize.origin).toBe('https://ducky.example')
    const back = await authorize(app, flow.authorize, { login: 'alice', auto: '1' })
    expect(`${back.origin}${back.pathname}`).toBe('https://ducky.example/api/auth/github/callback')
  })

  it('asks the real GitHub for an empty scope with PKCE and the configured callback', async () => {
    const { githubProvider } = await import('./auth/github')
    const { app } = setup({ provider: githubProvider({ clientId: 'Iv1.abc', clientSecret: 's' }), publicUrl: 'https://ducky.example' })
    const { authorize: url } = await begin(app)
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/login/oauth/authorize')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'Iv1.abc',
      redirect_uri: 'https://ducky.example/api/auth/github/callback',
      scope: '',
      allow_signup: 'true',
      code_challenge_method: 'S256',
    })
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect((await app.request(`${TEST_ORIGIN}/api/auth/fake-github/authorize`)).status).toBe(401)
  })

  it('refuses to start without a valid PKCE challenge', async () => {
    const { app } = setup()
    expect((await app.request('/api/auth/github/start')).status).toBe(400)
    expect((await app.request('/api/auth/github/start?challenge=short')).status).toBe(400)
  })

  it('hands off to the PWA through the fragment, and the exchange issues a session', async () => {
    const { app } = setup()
    const { fragment, verifier, res } = await roundTrip(app, 'alice')
    expect(res.headers.get('set-cookie')).toContain('rd_flow=;')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
    const handoff = fragment.get('handoff')!
    expect(handoff).toBeTruthy()
    const reply = await exchange(app, { handoff, verifier, name: 'Laptop' })
    expect(reply.status).toBe(200)
    const body = (await reply.json()) as { token: string; tokenId: string; user: { id: string; login: string; role: string } }
    expect(body.user).toMatchObject({ login: 'alice', role: 'user', name: null, avatarUrl: null })
    const session = (await (await request(app, 'GET', '/api/auth/session', undefined, body.token)).json()) as Record<string, unknown>
    expect(session).toMatchObject({ tokenId: body.tokenId, name: 'Laptop', kind: 'session', user: body.user })
  })

  it('signs the same GitHub id in as the same user and refreshes the login', async () => {
    const { app } = setup()
    const first = await roundTrip(app, 'old-name', { id: '4242' })
    const a = (await (await exchange(app, { handoff: first.fragment.get('handoff'), verifier: first.verifier })).json()) as { user: { id: string } }
    const second = await roundTrip(app, 'new-name', { id: '4242' })
    const b = (await (await exchange(app, { handoff: second.fragment.get('handoff'), verifier: second.verifier })).json()) as {
      user: { id: string; login: string }
    }
    expect(b.user).toMatchObject({ id: a.user.id, login: 'new-name' })
    expect((await signInAs(app, 'someone-else')).user.id).not.toBe(a.user.id)
  })

  it('rejects a callback without the cookie, with another flow\'s cookie, or with the wrong state', async () => {
    const { app } = setup()
    const mine = await begin(app)
    const back = await authorize(app, mine.authorize, { login: 'alice', auto: '1' })
    expect((await callback(app, back)).fragment.get('error')).toBe('invalid_state')

    const other = await begin(app)
    const otherBack = await authorize(app, other.authorize, { login: 'alice', auto: '1' })
    expect((await callback(app, otherBack, mine.cookie)).fragment.get('error')).toBe('invalid_state')

    const third = await begin(app)
    const thirdBack = await authorize(app, third.authorize, { login: 'alice', auto: '1' })
    thirdBack.searchParams.set('state', 'forged')
    expect((await callback(app, thirdBack, third.cookie)).fragment.get('error')).toBe('invalid_state')
    thirdBack.searchParams.set('state', third.authorize.searchParams.get('state')!)
    expect((await callback(app, thirdBack, third.cookie)).fragment.get('error')).toBe('invalid_state')
  })

  it('uses each flow once and expires it after 10 minutes', async () => {
    let now = 1_000_000
    const { app } = setup({ now: () => now })
    const flow = await begin(app)
    const back = await authorize(app, flow.authorize, { login: 'alice', auto: '1' })
    expect((await callback(app, back, flow.cookie)).fragment.get('handoff')).toBeTruthy()
    expect((await callback(app, back, flow.cookie)).fragment.get('error')).toBe('invalid_state')

    const late = await begin(app)
    const lateBack = await authorize(app, late.authorize, { login: 'alice', auto: '1' })
    now += 10 * 60_000
    expect((await callback(app, lateBack, late.cookie)).fragment.get('error')).toBe('invalid_state')
  })

  it('reports a GitHub denial as access_denied', async () => {
    const { app } = setup()
    const flow = await begin(app)
    const back = await authorize(app, flow.authorize, { auto: '1', deny: '1' })
    expect(back.searchParams.get('error')).toBe('access_denied')
    expect((await callback(app, back, flow.cookie)).fragment.get('error')).toBe('access_denied')
  })

  it('reports GitHub failures as github_error and logs them without secrets', async () => {
    const logged: LogEntry[] = []
    const provider: IdentityProvider = {
      authorizeUrl: ({ state, redirectUri }) => `${redirectUri}?code=c0de&state=${state}`,
      exchange: () => Promise.reject(new GitHubError('GitHub refused the code: bad_verification_code')),
    }
    const { app } = setup({ provider, log: (entry) => void logged.push(entry) })
    const flow = await begin(app)
    expect((await callback(app, flow.authorize, flow.cookie)).fragment.get('error')).toBe('github_error')
    expect(logged.find((entry) => entry.event === 'github_error')).toMatchObject({ error: 'GitHub refused the code: bad_verification_code' })
    expect(JSON.stringify(logged)).not.toContain('c0de')
  })

  it('makes the hand-off single use, bound to the verifier, and short-lived', async () => {
    let now = 1_000_000
    const { app } = setup({ now: () => now })
    const ok = await roundTrip(app, 'alice')
    expect((await exchange(app, { handoff: ok.fragment.get('handoff'), verifier: ok.verifier })).status).toBe(200)
    expect(await (await exchange(app, { handoff: ok.fragment.get('handoff'), verifier: ok.verifier })).json()).toEqual({ error: 'invalid_handoff' })

    const wrong = await roundTrip(app, 'alice')
    expect((await exchange(app, { handoff: wrong.fragment.get('handoff'), verifier: newVerifier() })).status).toBe(401)
    expect((await exchange(app, { handoff: wrong.fragment.get('handoff'), verifier: wrong.verifier })).status).toBe(401)

    const slow = await roundTrip(app, 'alice')
    now += 60_000
    expect((await exchange(app, { handoff: slow.fragment.get('handoff'), verifier: slow.verifier })).status).toBe(401)

    expect((await exchange(app, {})).status).toBe(401)
    const named = await roundTrip(app, 'alice')
    expect((await exchange(app, { handoff: named.fragment.get('handoff'), verifier: named.verifier, name: 'x'.repeat(101) })).status).toBe(400)
  })

  it('lets existing users in but refuses new accounts when signups are closed', async () => {
    const { app, db } = setup({ signups: { ...DEFAULT_SIGNUPS, open: false } })
    createUserSession(db, 'alice')
    expect((await signInAs(app, 'alice')).user.login).toBe('alice')
    expect((await roundTrip(app, 'bob')).fragment.get('error')).toBe('signups_closed')
  })

  it('caps the number of accounts', async () => {
    const { app } = setup({ signups: { ...DEFAULT_SIGNUPS, maxUsers: 1 } })
    await signInAs(app, 'alice')
    expect((await roundTrip(app, 'bob')).fragment.get('error')).toBe('signups_closed')
    expect((await signInAs(app, 'alice')).user.login).toBe('alice')
  })

  it('limits new accounts per hour across everyone', async () => {
    let now = 10_000_000
    const { app } = setup({ now: () => now, signups: { ...DEFAULT_SIGNUPS, perHour: 2 } })
    await signInAs(app, 'a1')
    await signInAs(app, 'a2')
    expect((await roundTrip(app, 'a3')).fragment.get('error')).toBe('rate_limited')
    expect((await signInAs(app, 'a1')).user.login).toBe('a1')
    now += 60 * 60_000
    expect((await signInAs(app, 'a3')).user.login).toBe('a3')
  })

  it('refuses a disabled account', async () => {
    const { app, db } = setup()
    const alice = createUserSession(db, 'alice')
    db.query("UPDATE users SET status = 'disabled' WHERE id = ?").run(alice.user.id)
    expect((await roundTrip(app, 'alice')).fragment.get('error')).toBe('account_disabled')

    const { app: other, db: otherDb } = setup()
    const pending = await roundTrip(other, 'carol')
    const carol = createUserSession(otherDb, 'carol')
    otherDb.query("UPDATE users SET status = 'disabled' WHERE id = ?").run(carol.user.id)
    expect((await exchange(other, { handoff: pending.fragment.get('handoff'), verifier: pending.verifier })).status).toBe(403)
  })
})

describe('fake GitHub', () => {
  it('shows a sign-in form that redirects back with a code', async () => {
    const { app } = setup()
    const flow = await begin(app)
    const page = await app.request(flow.authorize.toString())
    expect(page.status).toBe(200)
    expect(page.headers.get('X-Frame-Options')).toBe('DENY')
    expect(await page.text()).toContain('Sign in as')

    const res = await app.request(flow.authorize.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ state: flow.authorize.searchParams.get('state')!, login: 'dana', decision: 'approve' }).toString(),
    })
    const back = new URL(redirectOf(res))
    expect(back.pathname).toBe('/api/auth/github/callback')
    expect(back.searchParams.get('code')).toStartWith('fake_')
    expect((await callback(app, back, flow.cookie)).fragment.get('handoff')).toBeTruthy()
  })

  it('refuses unknown states and bad logins', async () => {
    const { app } = setup()
    expect((await app.request('/api/auth/fake-github/authorize?state=nope')).status).toBe(400)
    expect((await app.request('/api/auth/fake-github/authorize?state=nope&login=a&auto=1')).status).toBe(400)
    const flow = await begin(app)
    const bad = new URL(flow.authorize)
    bad.searchParams.set('login', '<script>')
    bad.searchParams.set('auto', '1')
    const res = await app.request(bad.toString())
    expect(res.status).toBe(400)
    expect(await res.text()).not.toContain('<script>')
  })
})
