import type { Database } from 'bun:sqlite'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { bearerToken } from '../auth/middleware'
import { OAUTH_SCOPE } from '../auth/oauth/routes'
import type { TokenStore } from '../auth/tokens'
import { tooManyRequests, type RateLimiter } from '../limits'
import { MCP_PATH, publicOrigin, resourceMetadataUrl } from '../origin'
import { createMcpServer } from './tools'

export interface McpRoutesOptions {
  db: Database
  tokens: TokenStore
  publicUrl?: string
  /** Per-user request rate. */
  limiter: RateLimiter
}

const MAX_BODY = 1024 * 1024

/** Settings tokens and OAuth access tokens; PWA device sessions are for /api only. */
const MCP_TOKEN_KINDS = new Set(['api', 'oauth'])

/**
 * Streamable HTTP, stateless: every POST gets a fresh server and transport, and answers with
 * plain JSON. There is no server-to-client stream, so GET and DELETE are refused.
 */
export function mcpRoutes({ db, tokens, publicUrl, limiter }: McpRoutesOptions) {
  const routes = new Hono()
  routes.use(
    MCP_PATH,
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'Accept', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id'],
      exposeHeaders: ['WWW-Authenticate', 'mcp-session-id'],
      maxAge: 86_400,
    }),
  )
  routes.use(MCP_PATH, bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: 'too_large' }, 413) }))

  routes.all(MCP_PATH, async (c) => {
    const raw = bearerToken(c)
    const principal = raw ? tokens.verify(raw) : null
    if (!principal || !MCP_TOKEN_KINDS.has(principal.kind)) {
      const challenge = [`resource_metadata="${resourceMetadataUrl(publicOrigin(c, publicUrl))}"`, `scope="${OAUTH_SCOPE}"`]
      if (raw) challenge.push('error="invalid_token"', 'error_description="The access token is invalid, expired or revoked"')
      c.header('WWW-Authenticate', `Bearer ${challenge.join(', ')}`)
      return c.json({ error: raw ? 'invalid_token' : 'unauthorized' }, 401)
    }
    const retryAfter = limiter.take(principal.userId)
    if (retryAfter !== null) return tooManyRequests(c, retryAfter)
    if (c.req.method !== 'POST') {
      c.header('Allow', 'POST')
      return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless' }, id: null }, 405)
    }

    const server = createMcpServer({ db, userId: principal.userId, actor: principal.name, origin: publicOrigin(c, publicUrl) })
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    try {
      return await transport.handleRequest(c.req.raw, {
        authInfo: {
          token: raw!,
          clientId: principal.clientId ?? principal.id,
          scopes: principal.scope ? principal.scope.split(' ') : [OAUTH_SCOPE],
          expiresAt: principal.expiresAt ? Math.floor(principal.expiresAt / 1000) : undefined,
        },
      })
    } finally {
      await server.close()
    }
  })

  return routes
}
