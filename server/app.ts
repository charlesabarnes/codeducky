import type { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { parseSyncRequest } from '../shared/sync'
import { requireToken, type AuthEnv } from './auth/middleware'
import type { FailureLimiter } from './auth/passphrase'
import { authRoutes } from './auth/routes'
import { createTokenStore } from './auth/tokens'
import { logErrors, requestLog, stdoutSink, type LogSink } from './log'
import { serveWeb } from './static'
import { sync } from './sync'

export interface AppDeps {
  db: Database
  passphrase: string
  webDist?: string
  now?: () => number
  log?: LogSink
  limiter?: FailureLimiter
}

const MAX_SYNC_BODY = 16 * 1024 * 1024

export function createApp({ db, passphrase, webDist, now, log = stdoutSink, limiter }: AppDeps) {
  const app = new Hono()
  const api = new Hono<AuthEnv>()
  const tokens = createTokenStore(db, now)

  api.use('*', requestLog(log))
  api.onError(logErrors(log))
  api.get('/health', (c) => c.json({ ok: true }))
  api.route('/auth', authRoutes({ tokens, passphrase, limiter }))

  api.post(
    '/sync',
    bodyLimit({ maxSize: MAX_SYNC_BODY, onError: (c) => c.json({ error: 'too_large' }, 413) }),
    requireToken(tokens, ['session', 'api']),
    async (c) => {
      const parsed = parseSyncRequest(await c.req.json().catch(() => null))
      if ('error' in parsed) return c.json({ error: parsed.error }, 400)
      return c.json(sync(db, parsed.cursor, parsed.changes, parsed.rejected))
    },
  )

  api.all('*', (c) => c.json({ error: 'not_found' }, 404))

  app.route('/api', api)
  if (webDist) app.use('*', serveWeb(webDist))
  return { app, tokens }
}
