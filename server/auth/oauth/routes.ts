import { createHash } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { mcpResource, PROTECTED_RESOURCE_PATH, publicOrigin, MCP_PATH } from '../../origin'
import { clientIp } from '../middleware'
import { createFailureLimiter, passphraseMatches, type FailureLimiter } from '../passphrase'
import { consentPage, errorPage, PAGE_HEADERS } from './consent'
import type { ClientAuthMethod, GrantType, OAuthClient, OAuthStore } from './store'

export const OAUTH_SCOPE = 'codeducky'
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

/** RFC 8707: the resource must name this MCP server (its /mcp URL, or the bare origin). */
export function canonicalResource(value: string | undefined, origin: string): string | null {
  const expected = mcpResource(origin)
  if (value === undefined || value === '') return expected
  try {
    const url = new URL(value)
    if (url.hash || url.search) return null
    const normalized = `${url.origin}${url.pathname.replace(/\/+$/, '')}`
    return normalized === expected || normalized === origin ? expected : null
  } catch {
    return null
  }
}

export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/
const CHALLENGE = /^[A-Za-z0-9\-_]{43}$/

type Params = Record<string, string>

async function readParams(c: Context): Promise<Params> {
  const type = c.req.header('content-type') ?? ''
  const raw: Record<string, unknown> = type.includes('application/json')
    ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>)
    : await c.req.parseBody().catch(() => ({}))
  const params: Params = {}
  for (const [key, value] of Object.entries(raw ?? {})) if (typeof value === 'string') params[key] = value
  return params
}

function oauthError(c: Context, error: string, description: string, status: 400 | 401 = 400) {
  c.header('Cache-Control', 'no-store')
  return c.json({ error, error_description: description }, status)
}

const AUTHORIZE_FIELDS = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource']

type AuthorizeCheck =
  | { kind: 'fatal'; message: string }
  | { kind: 'redirect'; location: string }
  | { kind: 'ok'; client: OAuthClient; redirectUri: string; challenge: string; resource: string; state?: string; echo: Params }

export interface OAuthRoutesOptions {
  store: OAuthStore
  passphrase: string
  limiter: FailureLimiter
  registrationLimiter?: FailureLimiter
  publicUrl?: string
}

export function oauthRoutes({
  store,
  passphrase,
  limiter,
  registrationLimiter = createFailureLimiter({ perClient: 20, global: 200, windowMs: 60 * 60_000 }),
  publicUrl,
}: OAuthRoutesOptions) {
  const routes = new Hono()
  const origin = (c: Context) => publicOrigin(c, publicUrl)

  const redirectWith = (base: string, values: Record<string, string | undefined>) => {
    const url = new URL(base)
    for (const [key, value] of Object.entries(values)) if (value !== undefined) url.searchParams.set(key, value)
    return url.toString()
  }

  /**
   * Checks an authorization request. Until the client and redirect URI are known to be good the
   * error is shown on the page; afterwards errors go back to the client, as OAuth requires.
   */
  function checkAuthorize(c: Context, params: Params): AuthorizeCheck {
    const client = params.client_id ? store.getClient(params.client_id) : null
    if (!client) return { kind: 'fatal', message: 'Unknown client. Register the client again and retry.' }
    const redirectUri = params.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined)
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      return { kind: 'fatal', message: 'The redirect URI does not match any URI this client registered.' }
    }
    const iss = origin(c)
    const fail = (error: string, description: string) => ({
      kind: 'redirect' as const,
      location: redirectWith(redirectUri, { error, error_description: description, state: params.state, iss }),
    })
    if (params.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported')
    if (!client.grantTypes.includes('authorization_code')) return fail('unauthorized_client', 'Client did not register authorization_code')
    if (params.code_challenge_method !== 'S256' || !CHALLENGE.test(params.code_challenge ?? '')) {
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required')
    }
    const resource = canonicalResource(params.resource, iss)
    if (!resource) return fail('invalid_target', `Unknown resource; use ${mcpResource(iss)}`)
    const echo: Params = {}
    for (const field of AUTHORIZE_FIELDS) if (params[field] !== undefined) echo[field] = params[field]
    echo.redirect_uri = redirectUri
    return { kind: 'ok', client, redirectUri, challenge: params.code_challenge!, resource, state: params.state, echo }
  }

  const htmlPage = (c: Context, body: string, status: 200 | 400 | 401 | 429 = 200) => c.body(body, status, PAGE_HEADERS)

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
    const { client, secret } = store.registerClient({ name, redirectUris: uris as string[], authMethod, grantTypes: [...new Set(grantTypes)] })
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

  routes.get('/oauth/authorize', (c) => {
    const check = checkAuthorize(c, c.req.query())
    if (check.kind === 'fatal') return htmlPage(c, errorPage(check.message), 400)
    if (check.kind === 'redirect') return c.redirect(check.location, 302)
    return htmlPage(c, consentPage({ clientName: check.client.name, redirectUri: check.redirectUri, params: check.echo }))
  })

  routes.post('/oauth/authorize', async (c) => {
    const params = await readParams(c)
    const check = checkAuthorize(c, params)
    if (check.kind === 'fatal') return htmlPage(c, errorPage(check.message), 400)
    if (check.kind === 'redirect') return c.redirect(check.location, 302)
    const iss = origin(c)
    if (params.decision !== 'approve') {
      return c.redirect(redirectWith(check.redirectUri, { error: 'access_denied', state: check.state, iss }), 302)
    }
    const view = { clientName: check.client.name, redirectUri: check.redirectUri, params: check.echo }
    const ip = clientIp(c)
    const retryAfter = limiter.retryAfter(ip)
    if (retryAfter !== null) {
      c.header('Retry-After', String(retryAfter))
      return htmlPage(c, consentPage({ ...view, error: 'Too many attempts. Wait a few minutes and try again.' }), 429)
    }
    if (!passphraseMatches(params.passphrase, passphrase)) {
      limiter.fail(ip)
      return htmlPage(c, consentPage({ ...view, error: 'Wrong passphrase.' }), 401)
    }
    limiter.succeed(ip)
    const code = store.createCode({
      clientId: check.client.id,
      redirectUri: check.redirectUri,
      codeChallenge: check.challenge,
      scope: OAUTH_SCOPE,
      resource: check.resource,
    })
    return c.redirect(redirectWith(check.redirectUri, { code, state: check.state, iss }), 302)
  })

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
