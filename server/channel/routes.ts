import type { Database } from 'bun:sqlite'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'
import { bearerToken, requireToken, type AuthEnv } from '../auth/middleware'
import type { TokenInfo, TokenStore } from '../auth/tokens'
import { publicOrigin } from '../origin'
import { loadData } from '../records/store'
import { taskContent, taskMeta } from './content'
import type { ChannelOwner, ChannelRegistry, PluginSink } from './registry'
import { parse, pluginEventSchema, registrationSchema, taskRequestSchema, verdictSchema } from './schemas'

export interface ChannelRoutesOptions {
  db: Database
  tokens: TokenStore
  registry: ChannelRegistry
  publicUrl?: string
}

const MAX_BODY = 64 * 1024

const ownerOf = (principal: TokenInfo): ChannelOwner => ({
  userId: principal.userId,
  tokenId: principal.id,
  grantId: principal.grantId,
  tokenName: principal.name,
})

/**
 * Keeps an SSE response open until the client goes away or `close` is called. Each heartbeat re-checks
 * the bearer token, so revoking it under Access tokens cuts the stream off.
 */
async function holdOpen(stream: SSEStreamingApi, heartbeatMs: number, beat: () => boolean) {
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (!beat()) stop()
    }, heartbeatMs)
    function stop() {
      clearInterval(timer)
      resolve()
    }
    stream.onAbort(stop)
  })
}

/**
 * Routes under /api/channel. The Claude Code plugin authenticates with an API or OAuth token and
 * connects out: POST /stream registers it and streams tasks and permission verdicts back. The PWA,
 * signed in with a device session, lists sessions, sends tasks and answers permission prompts.
 */
export function channelRoutes({ db, tokens, registry, publicUrl }: ChannelRoutesOptions) {
  const routes = new Hono<AuthEnv>()
  routes.use('*', bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: 'too_large' }, 413) }))
  const plugin = requireToken(tokens, ['api', 'oauth'])
  const browser = requireToken(tokens, ['session'])
  const body = (c: Context) => c.req.json().catch(() => null)

  routes.post('/stream', plugin, async (c) => {
    const registration = parse(registrationSchema, await body(c))
    if (!registration) return c.json({ error: 'invalid_registration' }, 400)
    const owner = ownerOf(c.get('principal'))
    const raw = bearerToken(c)!
    const admitted = registry.canConnect(registration.id, owner)
    if (admitted === 'conflict') return c.json({ error: 'conflict' }, 409)
    if (admitted === 'limit') return c.json({ error: 'session_limit' }, 409)
    return streamSSE(c, async (stream) => {
      const sink: PluginSink = ({ event, data }) => {
        if (stream.aborted || stream.closed) return false
        stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => stream.abort())
        return true
      }
      if (registry.connect(registration, owner, sink) !== 'ok') return
      await holdOpen(stream, registry.heartbeatMs, () => {
        if (!tokens.verify(raw)) {
          registry.removeOwner(owner)
          return false
        }
        return registry.ping(registration.id, owner, sink)
      })
      registry.disconnect(registration.id, owner, sink)
    })
  })

  routes.post('/sessions/:id/events', plugin, async (c) => {
    const event = parse(pluginEventSchema, await body(c))
    if (!event) return c.json({ error: 'invalid_event' }, 400)
    const id = c.req.param('id')
    const owner = ownerOf(c.get('principal'))
    let ok: boolean
    switch (event.type) {
      case 'delivered':
        ok = registry.delivered(id, owner, event.taskId)
        break
      case 'status':
        ok = registry.report(id, owner, event.taskId, event.state, event.message ?? null)
        break
      case 'permission_request':
        ok = registry.permissionRequest(id, owner, event)
        break
      case 'update':
        ok = registry.update(id, owner, { branch: event.branch, label: event.label })
        break
    }
    return ok ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404)
  })

  routes.delete('/sessions/:id', plugin, (c) =>
    registry.remove(c.req.param('id'), ownerOf(c.get('principal'))) ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404),
  )

  routes.get('/sessions', browser, (c) => c.json(registry.state(c.get('principal').userId)))

  routes.get('/events', browser, (c) => {
    const raw = bearerToken(c)!
    const { userId } = c.get('principal')
    return streamSSE(c, async (stream) => {
      const send = (state: ReturnType<ChannelRegistry['state']>) => {
        if (!stream.aborted && !stream.closed) stream.writeSSE({ event: 'state', data: JSON.stringify(state) }).catch(() => stream.abort())
      }
      const unsubscribe = registry.subscribe(userId, send)
      send(registry.state(userId))
      await holdOpen(stream, registry.heartbeatMs, () => {
        if (!tokens.verify(raw) || stream.aborted || stream.closed) return false
        stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => stream.abort())
        return true
      })
      unsubscribe()
    })
  })

  routes.post('/sessions/:id/tasks', browser, async (c) => {
    const request = parse(taskRequestSchema, await body(c))
    if (!request) return c.json({ error: 'invalid_task' }, 400)
    const { userId } = c.get('principal')
    const task = registry.sendTask(userId, c.req.param('id'), {
      kind: request.kind,
      repo: request.target.repo,
      branch: request.target.branch ?? null,
      pr: request.target.pr ?? null,
      sessionId: request.target.sessionId ?? null,
      content: taskContent(loadData(db, userId), request),
      meta: taskMeta(request, publicOrigin(c, publicUrl)),
    })
    if (task === 'not_found') return c.json({ error: 'not_found' }, 404)
    if (task === 'queue_full') return c.json({ error: 'queue_full' }, 409)
    return c.json({ task })
  })

  routes.post('/sessions/:id/permissions/:requestId', browser, async (c) => {
    const verdict = parse(verdictSchema, await body(c))
    if (!verdict) return c.json({ error: 'invalid_verdict' }, 400)
    const result = registry.decide(c.get('principal').userId, c.req.param('id'), c.req.param('requestId'), verdict.behavior)
    if (result === 'ok') return c.json({ ok: true })
    return c.json({ error: result }, result === 'not_found' ? 404 : 409)
  })

  return routes
}
