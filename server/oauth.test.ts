import { afterEach, describe, expect, it } from 'bun:test'
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { canonicalResource, isAllowedRedirectUri, pkceChallenge } from './auth/oauth/routes'
import { createFailureLimiter } from './auth/passphrase'
import { appFetch, login, makeApp, mcpClient, PASSPHRASE, request, TEST_ORIGIN } from './testing'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

const setup = (...args: Parameters<typeof makeApp>) => {
  const made = makeApp(...args)
  cleanups.push(made.cleanup)
  return made
}
type App = ReturnType<typeof makeApp>['app']

const REDIRECT = 'http://localhost:53682/callback'

/** The SDK's own OAuth client state, as Claude Code keeps it. */
class MemoryProvider implements OAuthClientProvider {
  client?: OAuthClientInformationMixed
  saved?: OAuthTokens
  verifier = ''
  authorizationUrl?: URL
  get redirectUrl() {
    return REDIRECT
  }
  get clientMetadata() {
    return {
      client_name: 'Claude Code (test)',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }
  state() {
    return 'state-123'
  }
  clientInformation() {
    return this.client
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.client = info
  }
  tokens() {
    return this.saved
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier
  }
  codeVerifier() {
    return this.verifier
  }
}

const form = (values: Record<string, string>) => new URLSearchParams(values).toString()
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' }

/** Submits the consent page as the owner would. */
async function approve(app: App, authorizationUrl: URL, passphrase = PASSPHRASE, decision = 'approve') {
  return app.request(`${TEST_ORIGIN}/oauth/authorize`, {
    method: 'POST',
    headers: FORM,
    body: form({ ...Object.fromEntries(authorizationUrl.searchParams), passphrase, decision }),
  })
}

async function register(app: App, metadata: Record<string, unknown>) {
  return app.request(`${TEST_ORIGIN}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata) })
}

async function token(app: App, values: Record<string, string>) {
  const res = await app.request(`${TEST_ORIGIN}/oauth/token`, { method: 'POST', headers: FORM, body: form(values) })
  return { status: res.status, body: (await res.json()) as Record<string, string> }
}

describe('oauth metadata', () => {
  it('publishes protected-resource and authorization-server metadata', async () => {
    const { app } = setup()
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      expect(await (await app.request(`${TEST_ORIGIN}${path}`)).json()).toMatchObject({
        resource: `${TEST_ORIGIN}/mcp`,
        authorization_servers: [TEST_ORIGIN],
      })
    }
    const as = (await (await app.request(`${TEST_ORIGIN}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>
    expect(as).toMatchObject({
      issuer: TEST_ORIGIN,
      authorization_endpoint: `${TEST_ORIGIN}/oauth/authorize`,
      token_endpoint: `${TEST_ORIGIN}/oauth/token`,
      registration_endpoint: `${TEST_ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
    })
  })

  it('uses the forwarded host and protocol behind a proxy', async () => {
    const { app } = setup()
    const res = await app.request('http://127.0.0.1:8787/.well-known/oauth-protected-resource', {
      headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'codeducky.example.com' },
    })
    expect(await res.json()).toMatchObject({ resource: 'https://codeducky.example.com/mcp' })
  })
})

describe('oauth flow', () => {
  it('runs register, authorize with PKCE, token, MCP use, refresh rotation and revocation', async () => {
    const { app, db } = setup()
    const provider = new MemoryProvider()
    const fetchFn = appFetch(app)
    const serverUrl = `${TEST_ORIGIN}/mcp`

    expect(await auth(provider, { serverUrl, fetchFn })).toBe('REDIRECT')
    const url = provider.authorizationUrl!
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('resource')).toBe(serverUrl)

    const page = await app.request(url.toString())
    expect(page.status).toBe(200)
    expect(page.headers.get('X-Frame-Options')).toBe('DENY')
    const html = await page.text()
    expect(html).toContain('Claude Code (test)')
    expect(html).toContain(REDIRECT)

    const wrong = await approve(app, url, 'not it')
    expect(wrong.status).toBe(401)
    expect(await wrong.text()).toContain('Wrong passphrase')

    const approved = await approve(app, url)
    expect(approved.status).toBe(302)
    const callback = new URL(approved.headers.get('Location')!)
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT)
    expect(callback.searchParams.get('state')).toBe('state-123')
    expect(callback.searchParams.get('iss')).toBe(TEST_ORIGIN)
    const code = callback.searchParams.get('code')!

    expect(await auth(provider, { serverUrl, fetchFn, authorizationCode: code })).toBe('AUTHORIZED')
    const first = provider.saved!
    expect(first.token_type).toBe('Bearer')
    expect(first.expires_in).toBe(3600)
    expect(first.refresh_token).toBeTruthy()

    // The code is single use.
    const clientId = provider.client!.client_id
    const replay = await token(app, { grant_type: 'authorization_code', code, code_verifier: provider.verifier, client_id: clientId, redirect_uri: REDIRECT })
    expect(replay).toMatchObject({ status: 400, body: { error: 'invalid_grant' } })

    const client = await mcpClient(app, first.access_token)
    const listed = await client.callTool({ name: 'list_repos', arguments: {} })
    expect(listed.isError).toBeFalsy()
    await client.close()

    // Settings lists the grant once, under the client's name.
    const owner = await login(app)
    const tokens = ((await (await request(app, 'GET', '/api/auth/tokens', undefined, owner)).json()) as { tokens: { id: string; kind: string; name: string }[] })
      .tokens
    const grants = tokens.filter((t) => t.kind === 'oauth')
    expect(grants).toEqual([expect.objectContaining({ name: 'Claude Code (test)' })])

    // Refresh rotates both tokens; the old access token stops working.
    const refreshed = await token(app, { grant_type: 'refresh_token', refresh_token: first.refresh_token!, client_id: clientId, resource: serverUrl })
    expect(refreshed.status).toBe(200)
    expect(refreshed.body.refresh_token).not.toBe(first.refresh_token)
    expect(refreshed.body.access_token).not.toBe(first.access_token)
    const mcpStatus = async (accessToken: string) =>
      (
        await app.request(`${TEST_ORIGIN}/mcp`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        })
      ).status
    expect(await mcpStatus(first.access_token)).toBe(401)
    expect(await mcpStatus(refreshed.body.access_token!)).toBe(200)

    // Revoking the grant in Settings rejects its access and refresh tokens.
    expect((await request(app, 'DELETE', `/api/auth/tokens/${grants[0]!.id}`, undefined, owner)).status).toBe(200)
    expect(await mcpStatus(refreshed.body.access_token!)).toBe(401)
    expect(await token(app, { grant_type: 'refresh_token', refresh_token: refreshed.body.refresh_token!, client_id: clientId })).toMatchObject({
      status: 400,
      body: { error: 'invalid_grant' },
    })
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens WHERE kind = 'oauth'").get()!.n).toBe(0)
  })

  it('revokes the whole grant when a rotated refresh token is replayed', async () => {
    const { app } = setup()
    const provider = new MemoryProvider()
    const fetchFn = appFetch(app)
    const serverUrl = `${TEST_ORIGIN}/mcp`
    await auth(provider, { serverUrl, fetchFn })
    const code = new URL((await approve(app, provider.authorizationUrl!)).headers.get('Location')!).searchParams.get('code')!
    await auth(provider, { serverUrl, fetchFn, authorizationCode: code })
    const clientId = provider.client!.client_id
    const old = provider.saved!.refresh_token!
    const next = await token(app, { grant_type: 'refresh_token', refresh_token: old, client_id: clientId })
    expect(next.status).toBe(200)
    expect(await token(app, { grant_type: 'refresh_token', refresh_token: old, client_id: clientId })).toMatchObject({ status: 400 })
    expect(await token(app, { grant_type: 'refresh_token', refresh_token: next.body.refresh_token!, client_id: clientId })).toMatchObject({
      status: 400,
      body: { error: 'invalid_grant' },
    })
  })

  it('rejects a wrong PKCE verifier, a plain challenge and a denied consent', async () => {
    const { app } = setup()
    const reg = (await (await register(app, { client_name: 'X', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' })).json()) as {
      client_id: string
    }
    const verifier = 'v'.repeat(50)
    const params = {
      response_type: 'code',
      client_id: reg.client_id,
      redirect_uri: REDIRECT,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
      state: 's',
    }
    const plain = await app.request(`${TEST_ORIGIN}/oauth/authorize?${form({ ...params, code_challenge_method: 'plain' })}`)
    expect(new URL(plain.headers.get('Location')!).searchParams.get('error')).toBe('invalid_request')

    const denied = await approve(app, new URL(`${TEST_ORIGIN}/oauth/authorize?${form(params)}`), '', 'deny')
    expect(new URL(denied.headers.get('Location')!).searchParams.get('error')).toBe('access_denied')

    const ok = await approve(app, new URL(`${TEST_ORIGIN}/oauth/authorize?${form(params)}`))
    const code = new URL(ok.headers.get('Location')!).searchParams.get('code')!
    expect(await token(app, { grant_type: 'authorization_code', code, code_verifier: 'w'.repeat(50), client_id: reg.client_id })).toMatchObject({
      status: 400,
      body: { error: 'invalid_grant' },
    })
  })

  it('requires the client secret for confidential clients', async () => {
    const { app } = setup()
    const reg = (await (await register(app, { client_name: 'claude.ai', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'client_secret_post' })).json()) as {
      client_id: string
      client_secret: string
    }
    expect(reg.client_secret).toStartWith('cdc_')
    const bad = await token(app, { grant_type: 'refresh_token', refresh_token: 'x', client_id: reg.client_id, client_secret: 'nope' })
    expect(bad).toMatchObject({ status: 401, body: { error: 'invalid_client' } })
    const good = await token(app, { grant_type: 'refresh_token', refresh_token: 'x', client_id: reg.client_id, client_secret: reg.client_secret })
    expect(good).toMatchObject({ status: 400, body: { error: 'invalid_grant' } })
  })

  it('rate-limits the consent passphrase together with sign-in', async () => {
    const limiter = createFailureLimiter({ perClient: 2, global: 50, windowMs: 60_000 })
    const { app } = setup({ limiter })
    const reg = (await (await register(app, { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' })).json()) as { client_id: string }
    const url = new URL(
      `${TEST_ORIGIN}/oauth/authorize?${form({ response_type: 'code', client_id: reg.client_id, code_challenge: pkceChallenge('v'.repeat(43)), code_challenge_method: 'S256' })}`,
    )
    expect((await approve(app, url, 'wrong')).status).toBe(401)
    expect((await request(app, 'POST', '/api/auth/login', { passphrase: 'wrong' })).status).toBe(401)
    expect((await approve(app, url)).status).toBe(429)
  })
})

describe('redirect uri validation', () => {
  it('allows https, loopback http and app schemes at registration', () => {
    for (const uri of ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:1234/callback', 'http://127.0.0.1/cb', 'cursor://anysphere.cursor-mcp/oauth']) {
      expect(isAllowedRedirectUri(uri)).toBe(true)
    }
    for (const uri of ['http://evil.example/cb', 'https://x.example/cb#frag', 'javascript:alert(1)', 'data:text/html,x', 'not a url', 42]) {
      expect(isAllowedRedirectUri(uri)).toBe(false)
    }
  })

  it('refuses bad registrations', async () => {
    const { app } = setup()
    expect((await register(app, { redirect_uris: ['http://evil.example/cb'] })).status).toBe(400)
    expect((await register(app, { redirect_uris: [] })).status).toBe(400)
    expect((await register(app, { redirect_uris: [REDIRECT], grant_types: ['client_credentials'] })).status).toBe(400)
  })

  it('only redirects to a URI exactly as registered', async () => {
    const { app } = setup()
    const reg = (await (await register(app, { redirect_uris: [REDIRECT, 'http://localhost:9999/other'], token_endpoint_auth_method: 'none' })).json()) as {
      client_id: string
    }
    const base = { response_type: 'code', client_id: reg.client_id, code_challenge: pkceChallenge('v'.repeat(43)), code_challenge_method: 'S256' }
    for (const redirect_uri of [`${REDIRECT}/`, `${REDIRECT}?x=1`, 'http://localhost:53683/callback', 'https://evil.example/callback']) {
      const res = await app.request(`${TEST_ORIGIN}/oauth/authorize?${form({ ...base, redirect_uri })}`)
      expect(res.status).toBe(400)
      expect(res.headers.get('Location')).toBeNull()
      expect(await res.text()).toContain('redirect URI does not match')
    }
    // With two registered URIs, one must be named.
    expect((await app.request(`${TEST_ORIGIN}/oauth/authorize?${form(base)}`)).status).toBe(400)
    expect((await app.request(`${TEST_ORIGIN}/oauth/authorize?${form({ ...base, redirect_uri: REDIRECT })}`)).status).toBe(200)
    // An unknown client gets the error page, not a redirect.
    expect((await app.request(`${TEST_ORIGIN}/oauth/authorize?${form({ ...base, client_id: 'nope', redirect_uri: REDIRECT })}`)).status).toBe(400)

    // The token request must repeat the same redirect URI.
    const ok = await approve(app, new URL(`${TEST_ORIGIN}/oauth/authorize?${form({ ...base, redirect_uri: REDIRECT })}`))
    const code = new URL(ok.headers.get('Location')!).searchParams.get('code')!
    expect(
      await token(app, { grant_type: 'authorization_code', code, code_verifier: 'v'.repeat(43), client_id: reg.client_id, redirect_uri: 'http://localhost:9999/other' }),
    ).toMatchObject({ status: 400, body: { error: 'invalid_grant' } })
  })

  it('accepts only this server as the resource', () => {
    const origin = 'https://codeducky.example.com'
    expect(canonicalResource(undefined, origin)).toBe(`${origin}/mcp`)
    expect(canonicalResource(`${origin}/mcp/`, origin)).toBe(`${origin}/mcp`)
    expect(canonicalResource('HTTPS://CODEDUCKY.example.com/mcp', origin)).toBe(`${origin}/mcp`)
    expect(canonicalResource(origin, origin)).toBe(`${origin}/mcp`)
    expect(canonicalResource('https://other.example.com/mcp', origin)).toBeNull()
  })
})
