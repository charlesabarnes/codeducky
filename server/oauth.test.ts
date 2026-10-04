import { afterEach, describe, expect, it } from 'bun:test'
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { WireChange } from '../shared/sync'
import { decideConsent, fakeConsent } from '../test/support/fakeSignIn'
import { canonicalResource } from './auth/oauth/authorize'
import { isAllowedRedirectUri } from './auth/oauth/routes'
import { pkceChallenge } from './auth/pkce'
import { DEFAULT_SIGNUPS } from './config'
import { record, repo, REPO } from './fixtures'
import { DEFAULT_RATE_LIMITS } from './limits'
import { appFetch, appSend, makeApp, mcpClient, request, signInAs, TEST_ORIGIN, userIdFor } from './testing'

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
const location = (res: Response) => new URL(res.headers.get('Location')!)
const codeOf = (res: Response) => location(res).searchParams.get('code')!

/** Opens the authorization URL in a browser that signs in to the fake GitHub as `login`. */
const consentAs = (app: App, url: URL | string, login = 'alice') => fakeConsent(appSend(app), url.toString(), login)

const decide = (app: App, page: { flow?: string; ticket?: string }, decision: 'approve' | 'deny' = 'approve') =>
  decideConsent(appSend(app), TEST_ORIGIN, page, decision)

/** Signs in to GitHub as `login` and approves on the consent page. */
async function approve(app: App, url: URL | string, login = 'alice') {
  const page = await consentAs(app, url, login)
  expect(page.status).toBe(200)
  return decide(app, page)
}

async function register(app: App, metadata: Record<string, unknown>) {
  return app.request(`${TEST_ORIGIN}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata) })
}

async function token(app: App, values: Record<string, string>) {
  const res = await app.request(`${TEST_ORIGIN}/oauth/token`, { method: 'POST', headers: FORM, body: form(values) })
  return { status: res.status, body: (await res.json()) as Record<string, string> }
}

const VERIFIER = 'v'.repeat(50)

/** A public client and an authorization URL for it, as an MCP client would build. */
async function publicClient(app: App, state = 's') {
  const reg = (await (await register(app, { client_name: 'X', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' })).json()) as {
    client_id: string
  }
  const params = {
    response_type: 'code',
    client_id: reg.client_id,
    redirect_uri: REDIRECT,
    code_challenge: pkceChallenge(VERIFIER),
    code_challenge_method: 'S256',
    state,
  }
  return { clientId: reg.client_id, params, url: `${TEST_ORIGIN}/oauth/authorize?${form(params)}` }
}

const exchangeCode = (app: App, clientId: string, code: string) =>
  token(app, { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: clientId, redirect_uri: REDIRECT })

/** Follows GET /oauth/authorize through the fake GitHub to the callback by hand, so tests can act in between. */
async function viaGitHub(app: App, url: string, query: Record<string, string>, between = () => {}) {
  const start = await app.request(url)
  const fake = location(start)
  for (const [key, value] of Object.entries(query)) fake.searchParams.set(key, value)
  const back = location(await app.request(fake.toString()))
  between()
  return app.request(back.toString(), { headers: { Cookie: start.headers.get('set-cookie')!.split(';')[0]! } })
}

async function seed(app: App, login: string, changes: WireChange[]) {
  const { token: session, user } = await signInAs(app, login)
  expect((await request(app, 'POST', '/api/sync', { cursor: 0, changes }, session)).status).toBe(200)
  return { session, user }
}

async function oauthGrants(app: App, session: string) {
  const body = (await (await request(app, 'GET', '/api/auth/tokens', undefined, session)).json()) as { tokens: { id: string; kind: string; name: string }[] }
  return body.tokens.filter((t) => t.kind === 'oauth')
}

async function repoNames(app: App, accessToken: string) {
  const client = await mcpClient(app, accessToken)
  try {
    const result = (await client.callTool({ name: 'list_repos', arguments: {} })) as CallToolResult
    expect(result.isError).toBeFalsy()
    return (JSON.parse((result.content[0] as { text: string }).text) as { repos: { repo: string }[] }).repos.map((r) => r.repo)
  } finally {
    await client.close()
  }
}

const BOB_REPO = record('repos', 'gh:bob/private', { owner: 'bob', name: 'private', folderName: 'private', baseBranch: 'main', lastOpenedAt: 5, checklistIds: [] })

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
  it('signs in with GitHub, asks for consent, and acts only for that user from code to token to MCP', async () => {
    const { app, db } = setup()
    const alice = await seed(app, 'alice', [repo()])
    const bob = await seed(app, 'bob', [BOB_REPO])
    const provider = new MemoryProvider()
    const fetchFn = appFetch(app)
    const serverUrl = `${TEST_ORIGIN}/mcp`

    expect(await auth(provider, { serverUrl, fetchFn })).toBe('REDIRECT')
    const url = provider.authorizationUrl!
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('resource')).toBe(serverUrl)

    const start = await app.request(url.toString())
    expect(start.status).toBe(302)
    expect(location(start).pathname).toBe('/api/auth/fake-github/authorize')
    expect(start.headers.get('set-cookie')).toContain('Path=/api/auth')

    const page = await consentAs(app, url, 'alice')
    expect(page.status).toBe(200)
    expect(page.headers.get('X-Frame-Options')).toBe('DENY')
    expect(page.headers.get('Cache-Control')).toBe('no-store')
    const csp = page.headers.get('Content-Security-Policy')!
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain('img-src https://avatars.githubusercontent.com')
    expect(page.html).toContain('Signed in to GitHub as <strong>@alice</strong>')
    expect(page.html).toContain('https://github.com/logout')
    expect(page.html).toContain('Claude Code (test)')
    expect(page.html).toContain(REDIRECT)
    expect([...page.html.matchAll(/type="hidden" name="([^"]+)"/g)].map((m) => m[1])).toEqual(['flow', 'ticket'])
    expect(page.html).not.toContain('passphrase')

    const approved = await decide(app, page)
    expect(approved.status).toBe(302)
    const callback = location(approved)
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

    expect(await repoNames(app, first.access_token)).toEqual([REPO])

    // Alice's Settings lists the grant once, under the client's name; Bob's lists none and cannot revoke it.
    const grants = await oauthGrants(app, alice.session)
    expect(grants).toEqual([expect.objectContaining({ name: 'Claude Code (test)' })])
    expect(await oauthGrants(app, bob.session)).toEqual([])
    expect((await request(app, 'DELETE', `/api/auth/tokens/${grants[0]!.id}`, undefined, bob.session)).status).toBe(404)

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
    expect((await request(app, 'DELETE', `/api/auth/tokens/${grants[0]!.id}`, undefined, alice.session)).status).toBe(200)
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
    const code = codeOf(await approve(app, provider.authorizationUrl!))
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

  it('rejects a wrong PKCE verifier and a plain challenge', async () => {
    const { app } = setup()
    const { clientId, params, url } = await publicClient(app)
    const plain = await app.request(`${TEST_ORIGIN}/oauth/authorize?${form({ ...params, code_challenge_method: 'plain' })}`)
    expect(location(plain).searchParams.get('error')).toBe('invalid_request')

    const code = codeOf(await approve(app, url))
    expect(await token(app, { grant_type: 'authorization_code', code, code_verifier: 'w'.repeat(50), client_id: clientId })).toMatchObject({
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
})

describe('oauth consent', () => {
  it('returns access_denied to the client on deny, and issues no code', async () => {
    const { app, db } = setup()
    const { url } = await publicClient(app, 'deny-state')
    const denied = location(await decide(app, await consentAs(app, url), 'deny'))
    expect(`${denied.origin}${denied.pathname}`).toBe(REDIRECT)
    expect(denied.searchParams.get('error')).toBe('access_denied')
    expect(denied.searchParams.get('state')).toBe('deny-state')
    expect(denied.searchParams.get('code')).toBeNull()
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM oauth_codes').get()!.n).toBe(0)
  })

  it('returns access_denied when the user cancels at GitHub', async () => {
    const { app } = setup()
    const { url } = await publicClient(app)
    const back = location(await viaGitHub(app, url, { auto: '1', deny: '1' }))
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT)
    expect(back.searchParams.get('error')).toBe('access_denied')
  })

  it('asks every time, even for a client the user already approved', async () => {
    const { app } = setup()
    const { url } = await publicClient(app)
    expect(codeOf(await approve(app, url))).toBeTruthy()
    const again = await consentAs(app, url)
    expect(again.status).toBe(200)
    expect(again.ticket).toBeTruthy()
  })

  it('uses each ticket once', async () => {
    const { app } = setup()
    const { url } = await publicClient(app)
    const page = await consentAs(app, url)
    expect((await decide(app, page)).status).toBe(302)
    const replay = await decide(app, page)
    expect(replay.status).toBe(400)
    expect(replay.headers.get('Location')).toBeNull()
    expect(await replay.text()).toContain('expired or was already used')
    expect((await decide(app, page, 'deny')).status).toBe(400)
  })

  it('refuses a ticket from another flow, and burns the flow it was tried on', async () => {
    const { app } = setup()
    const { url } = await publicClient(app)
    const first = await consentAs(app, url)
    const second = await consentAs(app, url)
    expect((await decide(app, { flow: first.flow, ticket: second.ticket })).status).toBe(400)
    expect((await decide(app, first)).status).toBe(400)
    expect((await decide(app, { flow: first.flow })).status).toBe(400)
    expect((await decide(app, {})).status).toBe(400)
    expect(codeOf(await decide(app, second))).toBeTruthy()
  })

  it('expires the consent page after 10 minutes', async () => {
    let now = 1_000_000
    const { app } = setup({ now: () => now })
    const { url } = await publicClient(app)
    const page = await consentAs(app, url)
    now += 10 * 60_000
    expect((await decide(app, page)).status).toBe(400)
  })

  it('checks the request again when the client is pruned meanwhile', async () => {
    const { app, db } = setup()
    const before = await publicClient(app)
    const prune = (clientId: string) => () => void db.query('DELETE FROM oauth_clients WHERE id = ?').run(clientId)
    const atCallback = await viaGitHub(app, before.url, { login: 'alice', auto: '1' }, prune(before.clientId))
    expect(atCallback.status).toBe(400)
    expect(await atCallback.text()).toContain('Unknown client')

    const after = await publicClient(app)
    const page = await consentAs(app, after.url)
    prune(after.clientId)()
    const decided = await decide(app, page)
    expect(decided.status).toBe(400)
    expect(decided.headers.get('Location')).toBeNull()
    expect(await decided.text()).toContain('Unknown client')
  })

  it('gives each user their own grant for the same client, acting only on their data', async () => {
    const { app } = setup()
    const alice = await seed(app, 'alice', [repo()])
    const bob = await seed(app, 'bob', [BOB_REPO])
    const { clientId, url } = await publicClient(app)
    const aliceTokens = await exchangeCode(app, clientId, codeOf(await approve(app, url, 'alice')))
    const bobTokens = await exchangeCode(app, clientId, codeOf(await approve(app, url, 'bob')))
    expect(await repoNames(app, aliceTokens.body.access_token!)).toEqual([REPO])
    expect(await repoNames(app, bobTokens.body.access_token!)).toEqual(['bob/private'])

    const [aliceGrant] = await oauthGrants(app, alice.session)
    const [bobGrant] = await oauthGrants(app, bob.session)
    expect(aliceGrant!.id).not.toBe(bobGrant!.id)
    expect((await request(app, 'DELETE', `/api/auth/tokens/${aliceGrant!.id}`, undefined, bob.session)).status).toBe(404)
    expect(await repoNames(app, aliceTokens.body.access_token!)).toEqual([REPO])
  })

  it('binds the code to the user who signed in at GitHub, whoever submits the form', async () => {
    const { app, db } = setup()
    const { clientId, url } = await publicClient(app)
    const page = await consentAs(app, url, 'alice')
    await signInAs(app, 'bob')
    expect((await exchangeCode(app, clientId, codeOf(await decide(app, page)))).status).toBe(200)
    const owner = db.query<{ user_id: string }, []>("SELECT user_id FROM tokens WHERE kind = 'oauth'").get()!.user_id
    expect(owner).toBe(userIdFor(db, 'alice'))
  })

  it('refuses consent to admin principals', async () => {
    const { app, db } = setup()
    await signInAs(app, 'mallory')
    db.query("UPDATE users SET role = 'admin' WHERE login = 'mallory'").run()
    const { url } = await publicClient(app)
    const page = await consentAs(app, url, 'mallory')
    expect(page.status).toBe(403)
    expect(page.flow).toBeUndefined()

    const pending = await consentAs(app, url, 'alice')
    db.query("UPDATE users SET role = 'admin' WHERE login = 'alice'").run()
    expect((await decide(app, pending)).status).toBe(403)
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM oauth_codes').get()!.n).toBe(0)
  })

  it('refuses disabled users at the callback, at approval, at the code exchange and at refresh', async () => {
    const { app, db } = setup()
    const setStatus = (status: 'active' | 'disabled') => db.query("UPDATE users SET status = ? WHERE login = 'dora'").run(status)
    const { clientId, url } = await publicClient(app)

    await signInAs(app, 'dora')
    setStatus('disabled')
    const refused = await consentAs(app, url, 'dora')
    expect(refused.status).toBe(403)
    expect(refused.html).toContain('disabled')
    setStatus('active')

    const pending = await consentAs(app, url, 'dora')
    setStatus('disabled')
    expect((await decide(app, pending)).status).toBe(403)
    setStatus('active')

    const code = codeOf(await approve(app, url, 'dora'))
    setStatus('disabled')
    expect(await exchangeCode(app, clientId, code)).toMatchObject({ status: 400, body: { error: 'invalid_grant' } })
    setStatus('active')

    const issued = await exchangeCode(app, clientId, codeOf(await approve(app, url, 'dora')))
    const refresh = () => token(app, { grant_type: 'refresh_token', refresh_token: issued.body.refresh_token!, client_id: clientId })
    setStatus('disabled')
    expect(await refresh()).toMatchObject({ status: 400, body: { error: 'invalid_grant' } })
    setStatus('active')
    expect((await refresh()).status).toBe(200)
  })

  it('shows sign-up refusals on a page instead of the consent form', async () => {
    const { app } = setup({ signups: { ...DEFAULT_SIGNUPS, open: false } })
    const { url } = await publicClient(app)
    const page = await consentAs(app, url, 'newcomer')
    expect(page.status).toBe(403)
    expect(page.html).toContain('New accounts are closed')
    expect(page.flow).toBeUndefined()
  })

  it('escapes the login and client name, and shows only GitHub avatars', async () => {
    const { consentPage } = await import('./auth/oauth/consent')
    const view = { clientName: '<b>x</b>', redirectUri: 'http://localhost/"cb', flow: 'f', ticket: 't' }
    const html = consentPage({ ...view, user: { login: '<i>eve</i>', avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4' } })
    expect(html).not.toContain('<b>x</b>')
    expect(html).not.toContain('<i>eve</i>')
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).toContain('http://localhost/&quot;cb')
    expect(html).toContain('<img class="avatar" src="https://avatars.githubusercontent.com/u/1?v=4"')
    expect(consentPage({ ...view, user: { login: 'eve', avatarUrl: 'https://evil.example/a.png' } })).not.toContain('<img')
  })

  it('limits authorization starts per client address', async () => {
    const { app } = setup({ limits: { ...DEFAULT_RATE_LIMITS, githubStart: { limit: 1, windowSec: 600, burst: 1 } } })
    const { url } = await publicClient(app)
    expect((await app.request(url)).status).toBe(302)
    const limited = await app.request(url)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
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
    expect((await app.request(`${TEST_ORIGIN}/oauth/authorize?${form({ ...base, redirect_uri: REDIRECT })}`)).status).toBe(302)
    // An unknown client gets the error page, not a redirect.
    expect((await app.request(`${TEST_ORIGIN}/oauth/authorize?${form({ ...base, client_id: 'nope', redirect_uri: REDIRECT })}`)).status).toBe(400)

    // The token request must repeat the same redirect URI.
    const code = codeOf(await approve(app, `${TEST_ORIGIN}/oauth/authorize?${form({ ...base, redirect_uri: REDIRECT })}`))
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
