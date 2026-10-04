import type { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { parseSyncRequest } from '../shared/sync'
import { requireToken, type AuthEnv } from './auth/middleware'
import { oauthRoutes } from './auth/oauth/routes'
import { createOAuthStore } from './auth/oauth/store'
import { createFailureLimiter, type FailureLimiter } from './auth/passphrase'
import { authRoutes } from './auth/routes'
import { createTokenStore } from './auth/tokens'
import { requireClientBuild } from './clientVersion'
import { createChannelRegistry, type ChannelRegistry } from './channel/registry'
import { channelRoutes } from './channel/routes'
import { gateApi, gateScripts } from './gate/routes'
import { createRateLimiters, perUser, rateLimit, type RateLimits } from './limits'
import { logErrors, requestLog, stdoutSink, type LogSink } from './log'
import { mcpRoutes } from './mcp/route'
import { setDefaultQuotas, type Quotas } from './records/quota'
import { sync } from './records/store'
import { serveWeb } from './static'
import { ensureAdmin } from './users/store'

export interface AppDeps {
  db: Database
  passphrase: string
  webDist?: string
  now?: () => number
  log?: LogSink
  /** Counts failed passphrase attempts from both the PWA sign-in and the OAuth consent page. */
  limiter?: FailureLimiter
  registrationLimiter?: FailureLimiter
  /** The public origin, when the proxy in front does not forward the host (CODEDUCKY_PUBLIC_URL). */
  publicUrl?: string
  /** Connected Claude Code channel sessions; tests pass one with a fake clock. */
  channel?: ChannelRegistry
  /** Request rates per user or per IP (config defaults, CODEDUCKY_RATE_*). */
  limits?: RateLimits
  /** Default per-user storage quotas; a user's own override wins. */
  quotas?: Quotas
  /** The oldest PWA build the API serves; defaults to MIN_CLIENT_BUILD. */
  minClientBuild?: string
}

const MAX_SYNC_BODY = 8 * 1024 * 1024
const MAX_API_BODY = 64 * 1024
const MAX_OAUTH_BODY = 16 * 1024
const tooLarge = (maxSize: number) => bodyLimit({ maxSize, onError: (c) => c.json({ error: 'too_large' }, 413) })

export function createApp({
  db,
  passphrase,
  webDist,
  now,
  log = stdoutSink,
  limiter = createFailureLimiter({ perClient: 10, global: 100, windowMs: 15 * 60_000 }),
  registrationLimiter,
  publicUrl,
  channel,
  limits,
  quotas,
  minClientBuild,
}: AppDeps) {
  ensureAdmin(db)
  if (quotas) setDefaultQuotas(db, quotas)
  const limiters = createRateLimiters(limits, now)
  const app = new Hono()
  const api = new Hono<AuthEnv>()
  const tokens = createTokenStore(db, now)
  const oauth = createOAuthStore(db, tokens, now)
  const registry = channel ?? createChannelRegistry({ now })
  if (!channel) setInterval(() => registry.sweep(), 15_000).unref()

  api.use('*', requestLog(log))
  api.onError(logErrors(log))
  api.use('*', requireClientBuild(minClientBuild))
  const apiBody = tooLarge(MAX_API_BODY)
  api.use('*', (c, next) => (c.req.path === '/api/sync' ? next() : apiBody(c, next)))
  api.get('/health', (c) => c.json({ ok: true }))
  api.route('/auth', authRoutes({ tokens, oauth, passphrase, limiter }))

  api.post(
    '/sync',
    tooLarge(MAX_SYNC_BODY),
    requireToken(tokens, ['session', 'api']),
    rateLimit(limiters.sync, perUser),
    async (c) => {
      const parsed = parseSyncRequest(await c.req.json().catch(() => null))
      if ('error' in parsed) return c.json({ error: parsed.error }, 400)
      return c.json(sync(db, c.get('principal').userId, parsed.cursor, parsed.changes, parsed.rejected))
    },
  )

  api.route('/gate', gateApi({ db, tokens, publicUrl, limiter: limiters.gate }))
  api.route('/channel', channelRoutes({ db, tokens, registry, publicUrl, taskLimiter: limiters.channelTasks }))

  api.all('*', (c) => c.json({ error: 'not_found' }, 404))

  const server = new Hono()
  for (const path of ['/mcp', '/oauth/*', '/.well-known/*', '/gate/*']) server.use(path, requestLog(log))
  server.onError(logErrors(log))
  server.use('/oauth/*', tooLarge(MAX_OAUTH_BODY))
  server.route('/', oauthRoutes({ store: oauth, passphrase, limiter, registrationLimiter, publicUrl }))
  server.route('/', mcpRoutes({ db, tokens, publicUrl, limiter: limiters.mcp }))
  server.route('/', gateScripts(publicUrl))

  app.route('/api', api)
  app.route('/', server)
  if (webDist) app.use('*', serveWeb(webDist))
  return { app, tokens, oauth, channel: registry, limiters }
}
