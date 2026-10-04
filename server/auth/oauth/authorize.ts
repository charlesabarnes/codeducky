import type { Database } from 'bun:sqlite'
import type { Context } from 'hono'
import type { RateLimiter } from '../../limits'
import { mcpResource, publicOrigin } from '../../origin'
import { getUser, type User } from '../../users/store'
import type { FlowCookie } from '../flowCookie'
import { FlowLimitError, type FlowStore } from '../flows'
import type { IdentityProvider } from '../github'
import { clientIp } from '../middleware'
import { CHALLENGE, pkceChallenge } from '../pkce'
import type { SignInError } from '../signin'
import { consentPage, errorPage, PAGE_HEADERS } from './consent'
import type { OAuthClient, OAuthStore } from './store'

export const OAUTH_SCOPE = 'codeducky'

export type Params = Record<string, string>

export async function readParams(c: Context): Promise<Params> {
  const type = c.req.header('content-type') ?? ''
  const raw: Record<string, unknown> = type.includes('application/json')
    ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>)
    : await c.req.parseBody().catch(() => ({}))
  const params: Params = {}
  for (const [key, value] of Object.entries(raw ?? {})) if (typeof value === 'string') params[key] = value
  return params
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

const redirectWith = (base: string, values: Record<string, string | undefined>) => {
  const url = new URL(base)
  for (const [key, value] of Object.entries(values)) if (value !== undefined) url.searchParams.set(key, value)
  return url.toString()
}

const parseRequest = (stored: string): Params => {
  try {
    const value = JSON.parse(stored) as unknown
    return value && typeof value === 'object' ? (value as Params) : {}
  } catch {
    return {}
  }
}

const AUTHORIZE_FIELDS = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource']

const SIGN_IN_ERRORS: Record<Exclude<SignInError, 'access_denied' | 'invalid_state'>, string> = {
  signups_closed: 'New accounts are closed on this Code Ducky server.',
  account_disabled: 'This Code Ducky account is disabled.',
  rate_limited: 'Too many new accounts right now. Try again later.',
  github_error: 'Could not sign in with GitHub. Start again from your MCP client.',
}

type AuthorizeCheck =
  | { kind: 'fatal'; message: string }
  | { kind: 'redirect'; location: string }
  | { kind: 'ok'; client: OAuthClient; redirectUri: string; challenge: string; resource: string; state?: string; echo: Params }

export interface AuthorizerOptions {
  db: Database
  store: OAuthStore
  flows: FlowStore
  provider: IdentityProvider
  cookie: FlowCookie
  /** Shared with PWA sign-in: every start stores a flow. */
  startLimiter: RateLimiter
  publicUrl?: string
}

/**
 * MCP consent through GitHub sign-in: the authorization request is checked and kept on the
 * server, GitHub says who is approving, and the consent form carries only a flow id and a
 * one-time ticket. Consent is asked for every time, even for a client the user approved before.
 */
export function createAuthorizer({ db, store, flows, provider, cookie, startLimiter, publicUrl }: AuthorizerOptions) {
  const origin = (c: Context) => publicOrigin(c, publicUrl)
  const htmlPage = (c: Context, body: string, status: 200 | 400 | 403 | 429 | 503 = 200) => c.body(body, status, PAGE_HEADERS)

  /**
   * Checks an authorization request. Until the client and redirect URI are known to be good the
   * error is shown on the page; afterwards errors go back to the client, as OAuth requires.
   */
  function check(c: Context, params: Params): AuthorizeCheck {
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

  /** Runs `check` and answers with the error page or the client redirect when it is not ok. */
  function checked(c: Context, params: Params, then: (ok: Extract<AuthorizeCheck, { kind: 'ok' }>) => Response | Promise<Response>) {
    const result = check(c, params)
    if (result.kind === 'fatal') return htmlPage(c, errorPage(result.message), 400)
    if (result.kind === 'redirect') return c.redirect(result.location, 302)
    return then(result)
  }

  const denied = (c: Context, redirectUri: string, state: string | undefined) =>
    c.redirect(redirectWith(redirectUri, { error: 'access_denied', state, iss: origin(c) }), 302)

  return {
    /** GET /oauth/authorize: keeps the checked request in a flow and sends the browser to GitHub. */
    start(c: Context) {
      return checked(c, c.req.query(), (ok) => {
        const ip = clientIp(c)
        const retryAfter = startLimiter.take(ip)
        if (retryAfter !== null) {
          c.header('Retry-After', String(retryAfter))
          return htmlPage(c, errorPage('Too many sign-in attempts. Wait a few minutes and try again.'), 429)
        }
        let flow: ReturnType<FlowStore['start']>
        try {
          flow = flows.start({ purpose: 'oauth', oauthRequest: JSON.stringify(ok.echo) }, ip)
        } catch (error) {
          if (!(error instanceof FlowLimitError)) throw error
          c.header('Retry-After', '600')
          return htmlPage(c, errorPage('Too many sign-ins in progress. Try again in a few minutes.'), 503)
        }
        cookie.set(c, flow.flowId)
        c.header('Cache-Control', 'no-store')
        c.header('Referrer-Policy', 'no-referrer')
        return c.redirect(
          provider.authorizeUrl({ state: flow.state, challenge: pkceChallenge(flow.githubVerifier), redirectUri: cookie.callbackUrl(c) }),
          302,
        )
      })
    },

    /**
     * The GitHub callback for an MCP consent flow. The stored request is checked again, since
     * its client may have been pruned meanwhile, and the consent page is shown to the user.
     */
    signedIn(c: Context, oauthRequest: string, result: User | SignInError) {
      return checked(c, parseRequest(oauthRequest), (ok) => {
        if (result === 'access_denied') return denied(c, ok.redirectUri, ok.state)
        if (typeof result === 'string') {
          return htmlPage(c, errorPage(result === 'invalid_state' ? SIGN_IN_ERRORS.github_error : SIGN_IN_ERRORS[result]), 403)
        }
        if (result.role !== 'user' || result.status !== 'active') return htmlPage(c, errorPage(SIGN_IN_ERRORS.account_disabled), 403)
        const { flow, ticket } = flows.awaitConsent(oauthRequest, result.id)
        return htmlPage(c, consentPage({ user: result, clientName: ok.client.name, redirectUri: ok.redirectUri, flow, ticket }))
      })
    },

    /** POST /oauth/authorize: the decision on the consent page, for the user GitHub signed in. */
    async decide(c: Context) {
      const params = await readParams(c)
      const pending = params.flow && params.ticket ? flows.takeConsent(params.flow, params.ticket) : null
      if (!pending) return htmlPage(c, errorPage('This approval expired or was already used. Start again from your MCP client.'), 400)
      return checked(c, parseRequest(pending.oauthRequest), (ok) => {
        if (params.decision !== 'approve') return denied(c, ok.redirectUri, ok.state)
        const user = getUser(db, pending.userId)
        if (!user || user.role !== 'user' || user.status !== 'active') return htmlPage(c, errorPage(SIGN_IN_ERRORS.account_disabled), 403)
        const code = store.createCode({
          userId: user.id,
          clientId: ok.client.id,
          redirectUri: ok.redirectUri,
          codeChallenge: ok.challenge,
          scope: OAUTH_SCOPE,
          resource: ok.resource,
        })
        return c.redirect(redirectWith(ok.redirectUri, { code, state: ok.state, iss: origin(c) }), 302)
      })
    },
  }
}

export type Authorizer = ReturnType<typeof createAuthorizer>
