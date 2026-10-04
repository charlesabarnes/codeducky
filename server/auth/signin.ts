import type { Database } from 'bun:sqlite'
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { SignupPolicy } from '../config'
import { tooManyRequests, type RateLimiter, type RateLimiters } from '../limits'
import type { LogSink } from '../log'
import { publicOrigin } from '../origin'
import { ADMIN_USER_ID, countUsers, getUser, getUserByGitHubId, upsertGitHubUser, type GitHubIdentity, type User } from '../users/store'
import { FLOW_TTL_MS, type FlowStore } from './flows'
import type { IdentityProvider } from './github'
import { clientIp } from './middleware'
import { passphraseMatches, type FailureLimiter } from './passphrase'
import { CHALLENGE, pkceChallenge } from './pkce'
import { tokenName, type TokenStore } from './tokens'

export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60_000
export const CALLBACK_PATH = '/api/auth/github/callback'
const SIGNIN_CALLBACK = '/signin/callback'
const COOKIE_PATH = '/api/auth'

export type SignInError = 'access_denied' | 'invalid_state' | 'signups_closed' | 'account_disabled' | 'github_error' | 'rate_limited'

export interface Profile {
  id: string
  login: string
  name: string | null
  avatarUrl: string | null
  role: User['role']
}

export const profile = ({ id, login, name, avatarUrl, role }: User): Profile => ({ id, login, name, avatarUrl, role })

/**
 * Lets an existing active user back in, or creates a new one if signups allow it. New accounts are
 * capped in total and by a rate shared across everyone, so open signup cannot be flooded.
 */
export function admitUser(
  db: Database,
  identity: GitHubIdentity,
  policy: SignupPolicy,
  newAccounts: RateLimiter,
  now: number,
): User | SignInError {
  const existing = getUserByGitHubId(db, identity.id)
  if (existing) return existing.status === 'active' ? upsertGitHubUser(db, identity, now) : 'account_disabled'
  if (!policy.open) return 'signups_closed'
  if (policy.maxUsers !== null && countUsers(db) >= policy.maxUsers) return 'signups_closed'
  if (newAccounts.take('global') !== null) return 'rate_limited'
  return upsertGitHubUser(db, identity, now)
}

export interface SignInRoutesOptions {
  db: Database
  tokens: TokenStore
  flows: FlowStore
  provider: IdentityProvider
  adminPassphrase?: string
  limiter: FailureLimiter
  limiters: RateLimiters
  signups: SignupPolicy
  publicUrl?: string
  log: LogSink
  now: () => number
}

/** GitHub sign-in for the PWA (start, callback, exchange) and the admin passphrase sign-in. */
export function signInRoutes({ db, tokens, flows, provider, adminPassphrase, limiter, limiters, signups, publicUrl, log, now }: SignInRoutesOptions) {
  const routes = new Hono()
  const origin = (c: Context) => publicOrigin(c, publicUrl)
  const secure = (c: Context) => origin(c).startsWith('https:')
  /** `__Host-` would need Path=/; `__Secure-` keeps the cookie on /api/auth only. */
  const cookieName = (c: Context) => (secure(c) ? '__Secure-rd_flow' : 'rd_flow')
  const clearCookie = (c: Context) => deleteCookie(c, cookieName(c), { path: COOKIE_PATH, secure: secure(c), httpOnly: true, sameSite: 'Lax' })
  const noStore = (c: Context) => {
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
  }

  const session = (c: Context, user: User, name: string, expiresAt: number | null) => {
    const { token, info } = tokens.issue({ userId: user.id, name, kind: 'session', expiresAt })
    noStore(c)
    return c.json({ token, tokenId: info.id, user: profile(user) })
  }

  routes.get('/github/start', (c) => {
    const challenge = c.req.query('challenge') ?? ''
    if (!CHALLENGE.test(challenge)) return c.json({ error: 'invalid_request' }, 400)
    const retryAfter = limiters.githubStart.take(clientIp(c))
    if (retryAfter !== null) return tooManyRequests(c, retryAfter)
    const flow = flows.start({ purpose: 'pwa', pwaChallenge: challenge })
    setCookie(c, cookieName(c), flow.flowId, {
      path: COOKIE_PATH,
      httpOnly: true,
      sameSite: 'Lax',
      secure: secure(c),
      maxAge: FLOW_TTL_MS / 1000,
    })
    noStore(c)
    return c.redirect(
      provider.authorizeUrl({ state: flow.state, challenge: pkceChallenge(flow.githubVerifier), redirectUri: `${origin(c)}${CALLBACK_PATH}` }),
      302,
    )
  })

  routes.get('/github/callback', async (c) => {
    noStore(c)
    const finish = (fragment: string) => {
      clearCookie(c)
      return c.redirect(`${SIGNIN_CALLBACK}#${fragment}`, 302)
    }
    const fail = (error: SignInError) => finish(`error=${error}`)

    const { code, state, error } = c.req.query()
    const flowId = getCookie(c, cookieName(c))
    const flow = flowId && state ? flows.take(flowId, state) : null
    if (!flow || flow.purpose !== 'pwa' || !flow.pwaChallenge) return fail('invalid_state')
    if (error) return fail(error === 'access_denied' ? 'access_denied' : 'github_error')
    if (!code) return fail('github_error')

    let identity: GitHubIdentity
    try {
      identity = await provider.exchange({ code, verifier: flow.githubVerifier, redirectUri: `${origin(c)}${CALLBACK_PATH}` })
    } catch (err) {
      log({ level: 'warn', event: 'github_error', error: err instanceof Error ? err.message : String(err) })
      return fail('github_error')
    }
    const user = admitUser(db, identity, signups, limiters.newAccounts, now())
    if (typeof user === 'string') return fail(user)
    return finish(`handoff=${flows.createHandoff(user.id, flow.pwaChallenge)}`)
  })

  routes.post('/exchange', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { handoff?: unknown; verifier?: unknown; name?: unknown } | null
    const name = tokenName(body?.name, 'Browser')
    if (name === null) return c.json({ error: 'invalid_name' }, 400)
    const userId = typeof body?.handoff === 'string' ? flows.consumeHandoff(body.handoff, body.verifier) : null
    if (!userId) return c.json({ error: 'invalid_handoff' }, 401)
    const user = getUser(db, userId)
    if (!user || user.status !== 'active') return c.json({ error: 'account_disabled' }, 403)
    return session(c, user, name, null)
  })

  routes.post('/admin/login', async (c) => {
    if (!adminPassphrase) return c.json({ error: 'not_found' }, 404)
    const ip = clientIp(c)
    const retryAfter = limiter.retryAfter(ip)
    if (retryAfter !== null) {
      c.header('Retry-After', String(retryAfter))
      return c.json({ error: 'too_many_attempts' }, 429)
    }
    const body = (await c.req.json().catch(() => null)) as { passphrase?: unknown; name?: unknown } | null
    if (!passphraseMatches(body?.passphrase, adminPassphrase)) {
      limiter.fail(ip)
      return c.json({ error: 'invalid_passphrase' }, 401)
    }
    limiter.succeed(ip)
    const name = tokenName(body?.name, 'Browser')
    if (name === null) return c.json({ error: 'invalid_name' }, 400)
    return session(c, getUser(db, ADMIN_USER_ID)!, name, now() + ADMIN_SESSION_TTL_MS)
  })

  if (provider.routes) routes.route('/', provider.routes)
  return routes
}
