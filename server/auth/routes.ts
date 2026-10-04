import type { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { DEFAULT_QUOTAS, DEFAULT_SIGNUPS, type Quotas, type SignupPolicy } from '../config'
import { silentSink, type LogSink } from '../log'
import { getUsage, getUser } from '../users/store'
import { createFlowStore } from './flows'
import type { IdentityProvider } from './github'
import { requireToken, type AuthEnv } from './middleware'
import type { OAuthStore } from './oauth/store'
import { createFailureLimiter, type FailureLimiter } from './passphrase'
import { profile, signInRoutes } from './signin'
import { tokenName, type TokenStore } from './tokens'

export interface AuthRoutesOptions {
  db: Database
  tokens: TokenStore
  oauth?: OAuthStore
  provider: IdentityProvider
  adminPassphrase?: string
  limiter?: FailureLimiter
  signups?: SignupPolicy
  quotas?: Quotas
  publicUrl?: string
  log?: LogSink
  now?: () => number
}

export function authRoutes({
  db,
  tokens,
  oauth,
  provider,
  adminPassphrase,
  limiter = createFailureLimiter({ perClient: 10, global: 100, windowMs: 15 * 60_000 }),
  signups = DEFAULT_SIGNUPS,
  quotas = DEFAULT_QUOTAS,
  publicUrl,
  log = silentSink,
  now = Date.now,
}: AuthRoutesOptions) {
  const routes = new Hono<AuthEnv>()
  const flows = createFlowStore(db, now)

  routes.route('/', signInRoutes({ db, tokens, flows, provider, adminPassphrase, limiter, signups, publicUrl, log, now }))

  routes.use('*', requireToken(tokens))

  /** The PWA calls this on load and focus: it refreshes the profile, and a 401 means signed out or disabled. */
  routes.get('/session', (c) => {
    const { id, name, kind, userId } = c.get('principal')
    const user = getUser(db, userId)!
    const usage = getUsage(db, userId)!
    return c.json({
      tokenId: id,
      name,
      kind,
      user: profile(user),
      usage: { records: usage.records, bytes: usage.bytes },
      quota: { records: usage.quotaRecords ?? quotas.records, bytes: usage.quotaBytes ?? quotas.bytes },
    })
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

  /** The admin account holds no review data, so it gets no API tokens. */
  sessionOnly.post('/', async (c) => {
    const principal = c.get('principal')
    if (principal.user.role === 'admin') return c.json({ error: 'forbidden' }, 403)
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null
    const name = tokenName(body?.name, '')
    if (!name) return c.json({ error: 'invalid_name' }, 400)
    const { token, info } = tokens.issue({ userId: principal.userId, name, kind: 'api' })
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
