import type { Database } from 'bun:sqlite'
import { Hono, type Context } from 'hono'
import { requireAdmin, requireToken, type AuthEnv } from '../auth/middleware'
import type { OAuthStore } from '../auth/oauth/store'
import type { TokenStore } from '../auth/tokens'
import type { ChannelRegistry } from '../channel/registry'
import { DEFAULT_SIGNUPS, type SignupPolicy } from '../config'
import { deleteUser, getUser, type User } from '../users/store'
import { forgetPendingSignIns, listAccounts, setQuotaOverride, setStatus, stats, type QuotaOverride } from './store'

export interface AdminRoutesOptions {
  db: Database
  tokens: TokenStore
  oauth: OAuthStore
  registry: ChannelRegistry
  signups?: SignupPolicy
  now?: () => number
}

/** A quota body: each limit a positive integer, null for the default, or left out to keep it. */
export function parseQuotaOverride(body: unknown): Partial<QuotaOverride> | null {
  if (!body || typeof body !== 'object') return null
  const override: Partial<QuotaOverride> = {}
  for (const key of ['records', 'bytes'] as const) {
    if (!(key in body)) continue
    const value = (body as Record<string, unknown>)[key]
    if (value !== null && !(Number.isSafeInteger(value) && (value as number) > 0)) return null
    override[key] = value as number | null
  }
  return Object.keys(override).length ? override : null
}

/**
 * Routes under /api/admin, for the built-in admin's PWA session only. The admin manages accounts
 * (status, quota, deletion) and sees usage, never record contents. The admin account itself is off limits.
 */
export function adminRoutes({ db, tokens, oauth, registry, signups = DEFAULT_SIGNUPS, now = Date.now }: AdminRoutesOptions) {
  const routes = new Hono<AuthEnv>()
  routes.use('*', requireToken(tokens, ['session']), requireAdmin)

  const summaries = () => {
    const tokenCounts = tokens.countsByUser()
    const grantCounts = oauth.countGrantsByUser()
    return listAccounts(db).map((account) => ({
      ...account,
      tokens: tokenCounts.get(account.id) ?? { session: 0, api: 0, oauth: 0 },
      grants: grantCounts.get(account.id) ?? 0,
      channelSessions: registry.state(account.id).sessions.filter((session) => session.connected).length,
    }))
  }

  const summaryOf = (id: string) => summaries().find((account) => account.id === id)!

  /** The GitHub account a route acts on; unknown ids are 404 and the admin account is refused. */
  const target = (c: Context<AuthEnv>): User | Response => {
    const user = getUser(db, c.req.param('id')!)
    if (!user) return c.json({ error: 'not_found' }, 404)
    if (user.role === 'admin' || user.id === c.get('principal').userId) return c.json({ error: 'cannot_modify_admin' }, 400)
    return user
  }

  routes.get('/users', (c) => c.json({ users: summaries() }))

  routes.get('/stats', (c) => c.json({ ...stats(db, now()), signupsOpen: signups.open, maxUsers: signups.maxUsers }))

  /** Signs the user out everywhere and drops anything mid-flight; plugin and PWA streams end at their next heartbeat. */
  routes.post('/users/:id/disable', (c) => {
    const user = target(c)
    if (user instanceof Response) return user
    db.transaction(() => {
      setStatus(db, user.id, 'disabled')
      oauth.revokeUserGrants(user.id)
      oauth.deleteUserCodes(user.id)
      tokens.revokeAllForUser(user.id)
      forgetPendingSignIns(db, user.id)
    })()
    registry.removeUser(user.id)
    return c.json({ user: summaryOf(user.id) })
  })

  routes.post('/users/:id/enable', (c) => {
    const user = target(c)
    if (user instanceof Response) return user
    setStatus(db, user.id, 'active')
    return c.json({ user: summaryOf(user.id) })
  })

  routes.delete('/users/:id', (c) => {
    const user = target(c)
    if (user instanceof Response) return user
    deleteUser(db, user.id)
    registry.removeUser(user.id)
    return c.json({ ok: true })
  })

  routes.patch('/users/:id/quota', async (c) => {
    const user = target(c)
    if (user instanceof Response) return user
    const override = parseQuotaOverride(await c.req.json().catch(() => null))
    if (!override) return c.json({ error: 'invalid_quota' }, 400)
    setQuotaOverride(db, user.id, override)
    return c.json({ user: summaryOf(user.id) })
  })

  return routes
}
