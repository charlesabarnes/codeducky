import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { mcpResource, PROTECTED_RESOURCE_PATH, publicOrigin, MCP_PATH } from '../../origin'
import { clientIp } from '../middleware'
import { createFailureLimiter, type FailureLimiter } from '../passphrase'
import { pkceChallenge, VERIFIER } from '../pkce'
import { canonicalResource, OAUTH_SCOPE, readParams, type Authorizer, type Params } from './authorize'
import { ClientLimitError, type ClientAuthMethod, type GrantType, type OAuthClient, type OAuthStore } from './store'

const AUTH_METHODS: readonly ClientAuthMethod[] = ['none', 'client_secret_post', 'client_secret_basic']
const GRANT_TYPES: readonly GrantType[] = ['authorization_code', 'refresh_token']
const MAX_REDIRECT_URIS = 10
const MAX_URI_LENGTH = 2000
const MAX_CLIENT_NAME = 100
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const BLOCKED_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'about:', 'blob:'])

/**
 * A redirect URI a client may register: absolute, no fragment, and either HTTPS, plain HTTP on
 * a loopback host (CLI clients such as Claude Code), or a private-use scheme for native apps.
 */
export function isAllowedRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_URI_LENGTH) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.hash || value.includes('#')) return false
  if (url.protocol === 'https:') return url.hostname !== ''
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname)
  return !BLOCKED_SCHEMES.has(url.protocol) && url.protocol.length > 2
}

function oauthError(c: Context, error: string, description: string, status: 400 | 401 = 400) {
  c.header('Cache-Control', 'no-store')
  return c.json({ error, error_description: description }, status)
}

export interface OAuthRoutesOptions {
  store: OAuthStore
  authorizer: Authorizer
  registrationLimiter?: FailureLimiter
  publicUrl?: string
}

export function oauthRoutes({
  store,
  authorizer,
  registrationLimiter = createFailureLimiter({ perClient: 20, global: 200, windowMs: 60 * 60_000 }),
  publicUrl,
}: OAuthRoutesOptions) {
  const routes = new Hono()
  const origin = (c: Context) => publicOrigin(c, publicUrl)

  const publicCors = cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'mcp-protocol-version'],
    maxAge: 86_400,
  })
  routes.use('/.well-known/*', publicCors)
  for (const path of ['/oauth/register', '/oauth/token', '/oauth/revoke']) routes.use(path, publicCors)

  const protectedResource = (c: Context) => {
    const iss = origin(c)
    return c.json({
      resource: mcpResource(iss),
      authorization_servers: [iss],
      scopes_supported: [OAUTH_SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Code Ducky',
    })
  }
  routes.get(PROTECTED_RESOURCE_PATH, protectedResource)
  routes.get(`${PROTECTED_RESOURCE_PATH}${MCP_PATH}`, protectedResource)

  routes.get('/.well-known/oauth-authorization-server', (c) => {
    const iss = origin(c)
    return c.json({
      issuer: iss,
      authorization_endpoint: `${iss}/oauth/authorize`,
      token_endpoint: `${iss}/oauth/token`,
      registration_endpoint: `${iss}/oauth/register`,
      revocation_endpoint: `${iss}/oauth/revoke`,
      scopes_supported: [OAUTH_SCOPE],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: GRANT_TYPES,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: AUTH_METHODS,
      revocation_endpoint_auth_methods_supported: AUTH_METHODS,
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${iss}/settings`,
    })
  })

  routes.post('/oauth/register', async (c) => {
    const ip = clientIp(c)
    const retryAfter = registrationLimiter.retryAfter(ip)
    if (retryAfter !== null) {
      c.header('Retry-After', String(retryAfter))
      return c.json({ error: 'too_many_requests', error_description: 'Too many registrations' }, 429)
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') return oauthError(c, 'invalid_client_metadata', 'Body must be a JSON object')
    const uris = body.redirect_uris
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
      return oauthError(c, 'invalid_redirect_uri', `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs`)
    }
    const bad = uris.find((uri) => !isAllowedRedirectUri(uri))
    if (bad !== undefined) {
      return oauthError(c, 'invalid_redirect_uri', `Not allowed: ${String(bad).slice(0, 200)}. Use https, http on localhost, or an app scheme.`)
    }
    const authMethod = (body.token_endpoint_auth_method ?? 'client_secret_basic') as ClientAuthMethod
    if (!AUTH_METHODS.includes(authMethod)) {
      return oauthError(c, 'invalid_client_metadata', `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(', ')}`)
    }
    const grantTypes = (body.grant_types ?? ['authorization_code']) as GrantType[]
    if (!Array.isArray(grantTypes) || grantTypes.length === 0 || grantTypes.some((type) => !GRANT_TYPES.includes(type))) {
      return oauthError(c, 'invalid_client_metadata', 'grant_types may only contain authorization_code and refresh_token')
    }
    const responseTypes = body.response_types ?? ['code']
    if (!Array.isArray(responseTypes) || responseTypes.some((type) => type !== 'code')) {
      return oauthError(c, 'invalid_client_metadata', 'response_types may only contain code')
    }
    const rawName = typeof body.client_name === 'string' ? body.client_name.trim() : ''
    const name = rawName.slice(0, MAX_CLIENT_NAME) || 'Unnamed MCP client'

    registrationLimiter.fail(ip)
    let registered: ReturnType<OAuthStore['registerClient']>
    try {
      registered = store.registerClient({ name, redirectUris: uris as string[], authMethod, grantTypes: [...new Set(grantTypes)] })
    } catch (error) {
      if (!(error instanceof ClientLimitError)) throw error
      c.header('Retry-After', '3600')
      return c.json({ error: 'temporarily_unavailable', error_description: 'Too many registered clients; try again later' }, 503)
    }
    const { client, secret } = registered
    c.header('Cache-Control', 'no-store')
    return c.json(
      {
        client_id: client.id,
        client_id_issued_at: Math.floor(client.createdAt / 1000),
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        grant_types: client.grantTypes,
        response_types: ['code'],
        token_endpoint_auth_method: client.authMethod,
        scope: OAUTH_SCOPE,
      },
      201,
    )
  })

  routes.get('/oauth/authorize', (c) => authorizer.start(c))
  routes.post('/oauth/authorize', (c) => authorizer.decide(c))

  /** Client authentication for the token and revocation endpoints (RFC 6749 §2.3). */
  function authenticateClient(c: Context, params: Params): OAuthClient | null {
    let clientId = params.client_id
    let secret = params.client_secret ?? null
    const basic = c.req.header('authorization')?.match(/^Basic\s+(\S+)$/i)?.[1]
    if (basic) {
      const decoded = Buffer.from(basic, 'base64').toString('utf8')
      const colon = decoded.indexOf(':')
      if (colon < 0) return null
      clientId = decodeURIComponent(decoded.slice(0, colon))
      secret = decodeURIComponent(decoded.slice(colon + 1))
    }
    const client = clientId ? store.getClient(clientId) : null
    if (!client || !store.secretMatches(client, secret)) return null
    return client
  }

  routes.post('/oauth/token', async (c) => {
    const params = await readParams(c)
    const client = authenticateClient(c, params)
    if (!client) return oauthError(c, 'invalid_client', 'Unknown client or wrong client secret', 401)
    c.header('Cache-Control', 'no-store')
    c.header('Pragma', 'no-cache')
    const reply = (tokens: { accessToken: string; refreshToken: string; expiresIn: number; scope: string }) =>
      c.json({
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope: tokens.scope,
      })

    if (params.grant_type === 'authorization_code') {
      const code = params.code ? store.consumeCode(params.code) : null
      if (!code || code.clientId !== client.id) return oauthError(c, 'invalid_grant', 'Unknown, used or expired authorization code')
      if (params.redirect_uri !== undefined && params.redirect_uri !== code.redirectUri) {
        return oauthError(c, 'invalid_grant', 'redirect_uri does not match the authorization request')
      }
      if (!VERIFIER.test(params.code_verifier ?? '') || pkceChallenge(params.code_verifier!) !== code.codeChallenge) {
        return oauthError(c, 'invalid_grant', 'PKCE verification failed')
      }
      if (params.resource && canonicalResource(params.resource, origin(c)) !== code.resource) {
        return oauthError(c, 'invalid_target', 'resource does not match the authorization request')
      }
      return reply(store.createGrant(client, code))
    }

    // Refresh is allowed even if the client registered only authorization_code: clients often omit it.
    if (params.grant_type === 'refresh_token') {
      if (!params.refresh_token) return oauthError(c, 'invalid_request', 'refresh_token is required')
      if (params.resource && !canonicalResource(params.resource, origin(c))) return oauthError(c, 'invalid_target', 'Unknown resource')
      const result = store.refresh(params.refresh_token, client)
      if ('error' in result) {
        return oauthError(
          c,
          'invalid_grant',
          result.error === 'reused' ? 'Refresh token was already used; the grant is revoked' : 'Unknown, revoked or expired refresh token',
        )
      }
      return reply(result.tokens)
    }

    return oauthError(c, 'unsupported_grant_type', 'Use authorization_code or refresh_token')
  })

  routes.post('/oauth/revoke', async (c) => {
    const params = await readParams(c)
    const client = authenticateClient(c, params)
    if (!client) return oauthError(c, 'invalid_client', 'Unknown client or wrong client secret', 401)
    if (params.token) store.revokeToken(params.token, client)
    return c.body(null, 200)
  })

  return routes
}
