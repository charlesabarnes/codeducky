import type { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { requireToken, type AuthEnv } from '../auth/middleware'
import type { TokenStore } from '../auth/tokens'
import type { ChannelRegistry } from '../channel/registry'
import { deleteUser } from '../users/store'

export interface AccountRoutesOptions {
  db: Database
  tokens: TokenStore
  registry: ChannelRegistry
}

/** Routes under /api/account: a user deleting their own account from the PWA. */
export function accountRoutes({ db, tokens, registry }: AccountRoutesOptions) {
  const routes = new Hono<AuthEnv>()

  /** Needs the user's login typed back. The built-in admin account cannot be deleted. */
  routes.delete('/', requireToken(tokens, ['session']), async (c) => {
    const { userId, user } = c.get('principal')
    if (user.role === 'admin') return c.json({ error: 'forbidden' }, 403)
    const body = (await c.req.json().catch(() => null)) as { confirm?: unknown } | null
    if (body?.confirm !== user.login) return c.json({ error: 'confirm_mismatch' }, 400)
    deleteUser(db, userId)
    registry.removeUser(userId)
    return c.json({ ok: true })
  })

  return routes
}
