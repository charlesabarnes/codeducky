import { Hono } from 'hono'
import { clientIp, requireToken, type AuthEnv } from './middleware'
import { createFailureLimiter, passphraseMatches, type FailureLimiter } from './passphrase'
import type { OAuthStore } from './oauth/store'
import { MAX_API_TOKENS, type TokenStore } from './tokens'
import { ADMIN_USER_ID } from '../users/store'

export interface AuthRoutesOptions {
  tokens: TokenStore
  oauth?: OAuthStore
  passphrase: string
  limiter?: FailureLimiter
}

const MAX_NAME = 100

function tokenName(value: unknown, fallback: string): string | null {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name && name.length <= MAX_NAME ? name : null
}

export function authRoutes({
  tokens,
  oauth,
  passphrase,
  limiter = createFailureLimiter({ perClient: 10, global: 100, windowMs: 15 * 60_000 }),
}: AuthRoutesOptions) {
  const routes = new Hono<AuthEnv>()

  /** The passphrase signs in to the built-in admin account until GitHub sign-in replaces it. */
  routes.post('/login', async (c) => {
    const ip = clientIp(c)
    const retryAfter = limiter.retryAfter(ip)
    if (retryAfter !== null) {
      c.header('Retry-After', String(retryAfter))
      return c.json({ error: 'too_many_attempts' }, 429)
    }
    const body = (await c.req.json().catch(() => null)) as { passphrase?: unknown; name?: unknown } | null
    if (!passphraseMatches(body?.passphrase, passphrase)) {
      limiter.fail(ip)
      return c.json({ error: 'invalid_passphrase' }, 401)
    }
    limiter.succeed(ip)
    const name = tokenName(body?.name, 'Browser')
    if (name === null) return c.json({ error: 'invalid_name' }, 400)
    const { token, info } = tokens.issue({ userId: ADMIN_USER_ID, name, kind: 'session' })
    return c.json({ token, tokenId: info.id, user: info.user })
  })

  routes.use('*', requireToken(tokens))

  routes.get('/session', (c) => {
    const { id, name, kind, user } = c.get('principal')
    return c.json({ tokenId: id, name, kind, user })
  })

  routes.post('/logout', (c) => {
    const { userId, id } = c.get('principal')
    tokens.revoke(userId, id)
    return c.json({ ok: true })
  })

  /** Token management is for the user signed in to the PWA, not for API or OAuth clients, and covers only their own. */
  const sessionOnly = new Hono<AuthEnv>()
  sessionOnly.use('*', async (c, next) => {
    if (c.get('principal').kind !== 'session') return c.json({ error: 'forbidden' }, 403)
    return next()
  })

  /** OAuth clients are listed once per grant (approval) rather than per short-lived access token. */
  sessionOnly.get('/', (c) => {
    const { id: current, userId } = c.get('principal')
    const own = tokens
      .list(userId)
      .filter((info) => info.grantId === null)
      .map((info) => ({ ...info, current: info.id === current }))
    const grants = (oauth?.listGrants(userId) ?? []).map((grant) => ({
      id: grant.id,
      name: grant.clientName,
      kind: 'oauth' as const,
      createdAt: grant.createdAt,
      lastUsedAt: grant.lastUsedAt,
      expiresAt: grant.expiresAt,
      clientId: grant.clientId,
      scope: grant.scope,
      grantId: grant.id,
      current: false,
    }))
    return c.json({ tokens: [...own, ...grants].sort((a, b) => b.createdAt - a.createdAt) })
  })

  sessionOnly.post('/', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null
    const name = tokenName(body?.name, '')
    if (!name) return c.json({ error: 'invalid_name' }, 400)
    const { userId } = c.get('principal')
    if (tokens.countByKind(userId, 'api') >= MAX_API_TOKENS) return c.json({ error: 'token_limit' }, 409)
    const { token, info } = tokens.issue({ userId, name, kind: 'api' })
    return c.json({ token, info })
  })

  sessionOnly.delete('/:id', (c) => {
    const id = c.req.param('id')
    const { userId } = c.get('principal')
    const revoked = tokens.revoke(userId, id) || (oauth?.revokeUserGrant(userId, id) ?? false)
    return revoked ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404)
  })

  routes.route('/tokens', sessionOnly)
  return routes
}
