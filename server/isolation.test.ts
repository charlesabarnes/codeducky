import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ChannelState } from '../shared/channel'
import type { SyncResponse, WireChange } from '../shared/sync'
import { decideConsent, fakeConsent, type SignedIn } from '../test/support/fakeSignIn'
import { createChannelRegistry, type Registration } from './channel/registry'
import { pkceChallenge } from './auth/pkce'
import { checklist, note, record, repo, REPO, REPO_ID, session, ticked } from './fixtures'
import { readRecord } from './records/store'
import { adminLogin, appSend, makeApp, mcpClient, request, signInAs, sseReader, TEST_ORIGIN } from './testing'
import { getUser } from './users/store'

/**
 * The security gate for multi-user Code Ducky: every route the server mounts is classified, and every
 * route that acts on a user's data is called by Bob against Alice's ids, with Alice's view compared
 * before and after. MCP tools and prompts have their own matrix in mcpIsolation.test.ts.
 */

type RouteClass = 'cross-user' | 'public' | 'admin'

/** Every method and path in `app.routes`, middleware included. A new endpoint fails the guard until it is listed here. */
const ROUTES: Record<string, RouteClass> = {
  // Middleware (logging, body limits, client build, auth) and the JSON 404 for unknown /api paths.
  'ALL /api/*': 'public',
  'ALL /api/auth/*': 'public',
  'ALL /api/auth/tokens/*': 'public',
  'ALL /api/channel/*': 'public',
  'ALL /api/admin/*': 'admin',
  'ALL /oauth/*': 'public',
  'ALL /.well-known/*': 'public',
  'ALL /gate/*': 'public',
  'ALL /oauth/register': 'public',
  'ALL /oauth/token': 'public',
  'ALL /oauth/revoke': 'public',
  // The built PWA.
  'ALL /*': 'public',

  'GET /api/health': 'public',
  // Sign-in: the GitHub round-trip and hand-off are bound to the browser by cookie, state and verifier (signin.test.ts).
  'GET /api/auth/github/start': 'public',
  'GET /api/auth/github/callback': 'public',
  'POST /api/auth/exchange': 'public',
  'POST /api/auth/admin/login': 'public',
  'GET /api/auth/fake-github/authorize': 'public',
  'POST /api/auth/fake-github/authorize': 'public',
  'GET /.well-known/oauth-protected-resource': 'public',
  'GET /.well-known/oauth-protected-resource/mcp': 'public',
  'GET /.well-known/oauth-authorization-server': 'public',
  'POST /oauth/register': 'public',
  'GET /oauth/authorize': 'public',
  'GET /gate/:script': 'public',

  'GET /api/auth/session': 'cross-user',
  'POST /api/auth/logout': 'cross-user',
  'GET /api/auth/tokens': 'cross-user',
  'POST /api/auth/tokens': 'cross-user',
  'DELETE /api/auth/tokens/:id': 'cross-user',
  'POST /api/sync': 'cross-user',
  'GET /api/gate': 'cross-user',
  'POST /api/channel/stream': 'cross-user',
  'POST /api/channel/sessions/:id/events': 'cross-user',
  'DELETE /api/channel/sessions/:id': 'cross-user',
  'GET /api/channel/sessions': 'cross-user',
  'GET /api/channel/events': 'cross-user',
  'POST /api/channel/sessions/:id/tasks': 'cross-user',
  'POST /api/channel/sessions/:id/permissions/:requestId': 'cross-user',
  'DELETE /api/account': 'cross-user',
  'ALL /mcp': 'cross-user',
  'POST /oauth/authorize': 'cross-user',
  'POST /oauth/token': 'cross-user',
  'POST /oauth/revoke': 'cross-user',

  'GET /api/admin/users': 'admin',
  'GET /api/admin/stats': 'admin',
  'POST /api/admin/users/:id/disable': 'admin',
  'POST /api/admin/users/:id/enable': 'admin',
  'DELETE /api/admin/users/:id': 'admin',
  'PATCH /api/admin/users/:id/quota': 'admin',
}

const ALICE_SECRET = 'Alice-only rule: never log card numbers.'
const ALICE_REPO = 'alice/ledger'
const ALICE_PRIVATE = 'alice-private-0001'
const SHARED_CHANNEL = 'shared-channel-0001'
const REDIRECT = 'http://localhost:53682/callback'
const VERIFIER = 'v'.repeat(50)

/** Alice's synced data. The repo and inbox ids are deterministic, so Bob's collide with them by design. */
const ALICE_DATA: WireChange[] = [
  repo({ instructions: ALICE_SECRET }),
  record('repos', `gh:${ALICE_REPO}`, { owner: 'alice', name: 'ledger', folderName: 'ledger', baseBranch: 'main', lastOpenedAt: 1, checklistIds: [] }),
  session('alice-s1', 'feature/tax'),
  session('alice-s2', 'feature/ledger', { repoId: `gh:${ALICE_REPO}` }),
  note('alice-n1', 'alice-s1', { body: 'Alice private finding' }),
  checklist('alice-cl', 'Alice checklist', [['alice-i1', 'Alice item']]),
  ticked('alice-s1', 'alice-i1'),
  record('inbox', 'inbox', { fetchedAt: 1, items: [{ repo: REPO, number: 42, title: 'Alice inbox', author: 'octo', url: 'u', updatedAt: 'x', section: 'requested' }] }),
]

/** Bob writes Alice's ids with his own contents. */
const BOB_COPY: WireChange[] = [
  repo({ instructions: 'Bob rules' }),
  record('inbox', 'inbox', { fetchedAt: 2, items: [] }),
  session('alice-s1', 'bob-branch'),
  note('alice-n1', 'alice-s1', { body: 'Bob copy' }),
]

const registration = (id: string, label: string): Registration => ({
  id,
  label,
  cwd: '/src/ledger',
  repo: ALICE_REPO,
  branch: 'feature/ledger',
  hostname: 'laptop',
  pluginVersion: '0.1.0',
})

const webDist = mkdtempSync(join(tmpdir(), 'codeducky-isolation-web-'))
const ctx = makeApp({ channel: createChannelRegistry({ heartbeatMs: 50 }), webDist })
const send = (method: string, path: string, token?: string, body?: unknown) => request(ctx.app, method, path, body, token)
const json = async <T = Record<string, unknown>>(res: Response | Promise<Response>) => (await (await res).json()) as T
const streams: { close: () => Promise<void> }[] = []
const clients: Client[] = []

/** Waits for the first SSE event that is not a heartbeat. */
async function nextEvent(stream: ReturnType<typeof sseReader>) {
  for (;;) {
    const event = await stream.next()
    if (event.event !== 'ping') return event
  }
}

async function registerClient(name: string) {
  const body = { client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] }
  return (await json<{ client_id: string }>(ctx.app.request(`${TEST_ORIGIN}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))).client_id
}

const authorizeUrl = (clientId: string) =>
  `${TEST_ORIGIN}/oauth/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: pkceChallenge(VERIFIER),
    code_challenge_method: 'S256',
    state: 's',
  })}`

const consent = (clientId: string, login: string) => fakeConsent(appSend(ctx.app), authorizeUrl(clientId), login)

async function approve(clientId: string, login: string) {
  const res = await decideConsent(appSend(ctx.app), TEST_ORIGIN, await consent(clientId, login), 'approve')
  return new URL(res.headers.get('location')!).searchParams.get('code')!
}

function oauthToken(values: Record<string, string>) {
  return ctx.app.request(`${TEST_ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values).toString(),
  })
}

async function exchange(clientId: string, code: string) {
  const res = await oauthToken({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: clientId, redirect_uri: REDIRECT })
  return { status: res.status, body: (await res.json()) as { access_token: string; refresh_token: string; error?: string } }
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult
  const text = (result.content[0] as { text: string }).text
  return result.isError ? { error: text } : (JSON.parse(text) as Record<string, unknown>)
}

const pull = (token: string) => json<SyncResponse>(send('POST', '/api/sync', token, { cursor: 0, changes: [] }))
const mint = (session: string, name: string) => json<{ token: string; info: { id: string } }>(send('POST', '/api/auth/tokens', session, { name }))
const tokenIds = async (session: string) => (await json<{ tokens: { id: string }[] }>(send('GET', '/api/auth/tokens', session))).tokens.map((t) => t.id)
const gate = (token: string, repoName: string, branch: string) =>
  json<{ pass: boolean; reasons: string[] }>(send('GET', `/api/gate?repo=${repoName}&branch=${branch}`, token))

interface Account {
  signedIn: SignedIn
  session: string
  api: string
  apiId: string
}

let alice: Account & { oauthClient: string; access: string; refresh: string; grantId: string; taskId: string; mcpNoteId: string }
let bob: Account & { oauthClient: string; access: string; plugin: ReturnType<typeof sseReader> }
let baseline: unknown

async function account(login: string): Promise<Account> {
  const signedIn = await signInAs(ctx.app, login)
  const { token: api, info } = await mint(signedIn.token, `${login} Claude`)
  return { signedIn, session: signedIn.token, api, apiId: info.id }
}

/** Everything of Alice's that Bob could reach: records, session, tokens and grants, channel state, and her credentials still working. */
async function aliceView() {
  const records = (await pull(alice.session)).changes.map(({ kind, id, rev, data }) => ({ kind, id, rev, data }))
  const me = await json<{ user: { login: string }; usage: unknown }>(send('GET', '/api/auth/session', alice.session))
  const tokens = (await json<{ tokens: { id: string; kind: string; name: string; expiresAt: number | null }[] }>(send('GET', '/api/auth/tokens', alice.session))).tokens.map(
    ({ id, kind, name, expiresAt }) => ({ id, kind, name, expiresAt }),
  )
  const channel = await json<ChannelState>(send('GET', '/api/channel/sessions', alice.session))
  return {
    records,
    user: me.user.login,
    usage: me.usage,
    tokens,
    channel: {
      sessions: channel.sessions.map((s) => [s.id, s.label, s.connected]),
      tasks: channel.tasks.map((t) => [t.id, t.state]),
      permissions: channel.permissions.map((p) => [p.requestId, p.state]),
    },
    apiWorks: (await gate(alice.api, ALICE_REPO, 'feature/ledger')).pass,
    oauthWorks: ctx.tokens.verify(alice.access)?.userId === alice.signedIn.user.id,
  }
}

beforeAll(async () => {
  const a = await account('alice')
  expect((await json<SyncResponse>(send('POST', '/api/sync', a.session, { cursor: 0, changes: ALICE_DATA }))).rejected).toEqual([])

  const mcp = await mcpClient(ctx.app, a.api)
  clients.push(mcp)
  const added = (await callTool(mcp, 'add_note', { session: 'alice-s2', path: 'ledger.ts', line: 3, body: 'Added over MCP' })) as { added: { id: string } }

  const oauthClient = await registerClient('Alice Claude')
  const issued = await exchange(oauthClient, await approve(oauthClient, 'alice'))
  expect(issued.status).toBe(200)
  const grantId = ctx.tokens.verify(issued.body.access_token)!.grantId!

  const shared = sseReader(await send('POST', '/api/channel/stream', a.api, registration(SHARED_CHANNEL, 'alice laptop')))
  const own = sseReader(await send('POST', '/api/channel/stream', a.api, registration(ALICE_PRIVATE, 'alice desktop')))
  streams.push(shared, own)
  expect((await shared.next()).event).toBe('ready')
  expect((await own.next()).event).toBe('ready')
  const task = await json<{ task: { id: string } }>(
    send('POST', `/api/channel/sessions/${ALICE_PRIVATE}/tasks`, a.session, { kind: 'review', target: { repo: ALICE_REPO, branch: 'feature/ledger' } }),
  )
  expect((await nextEvent(own)).event).toBe('task')
  const prompt = { type: 'permission_request', requestId: 'abcde', toolName: 'Bash', description: 'Run tests', inputPreview: '{}' }
  expect((await send('POST', `/api/channel/sessions/${ALICE_PRIVATE}/events`, a.api, prompt)).status).toBe(200)

  alice = { ...a, oauthClient, access: issued.body.access_token, refresh: issued.body.refresh_token, grantId, taskId: task.task.id, mcpNoteId: added.added.id }

  const b = await account('bob')
  const bobClient = await registerClient('Bob Claude')
  const bobIssued = await exchange(bobClient, await approve(bobClient, 'bob'))
  const plugin = sseReader(await send('POST', '/api/channel/stream', b.api, registration('bob-own-session-01', 'bob laptop')))
  streams.push(plugin)
  expect((await plugin.next()).event).toBe('ready')
  bob = { ...b, oauthClient: bobClient, access: bobIssued.body.access_token, plugin }

  baseline = await aliceView()
})

afterAll(async () => {
  await Promise.all([...streams.map((s) => s.close().catch(() => undefined)), ...clients.map((c) => c.close())])
  ctx.cleanup()
  rmSync(webDist, { recursive: true, force: true })
})

/** Bob, signed in to his own account, calls each route against Alice's ids. Alice's view is compared after each. */
const CROSS_USER: Record<string, () => Promise<void>> = {
  async 'POST /api/sync'() {
    const fresh = await pull(bob.session)
    expect(fresh.changes).toEqual([])
    const pushed = await json<SyncResponse>(send('POST', '/api/sync', bob.session, { cursor: 0, changes: BOB_COPY }))
    expect(pushed.rejected).toEqual([])
    const mine = await pull(bob.session)
    expect(mine.changes.map((c) => `${c.kind}:${c.id}`).sort()).toEqual(['inbox:inbox', 'notes:alice-n1', `repos:${REPO_ID}`, 'sessions:alice-s1'])
    expect(JSON.stringify(mine)).not.toContain(ALICE_SECRET)
    expect(JSON.stringify(mine)).not.toContain('Alice')
    expect(readRecord(ctx.db, alice.signedIn.user.id, 'notes', 'alice-n1')!.data).toMatchObject({ body: 'Alice private finding' })
    expect(readRecord(ctx.db, alice.signedIn.user.id, 'inbox', 'inbox')!.data).toMatchObject({ items: [{ title: 'Alice inbox' }] })
  },

  async 'GET /api/auth/session'() {
    const me = await json<{ user: { id: string; login: string }; usage: { records: number } }>(send('GET', '/api/auth/session', bob.session))
    expect(me.user).toMatchObject({ id: bob.signedIn.user.id, login: 'bob' })
    expect(me.usage.records).toBe((await pull(bob.session)).changes.length)
  },

  async 'POST /api/auth/logout'() {
    const other = await signInAs(ctx.app, 'bob', 'Bob phone')
    expect((await send('POST', '/api/auth/logout', other.token)).status).toBe(200)
    expect((await send('GET', '/api/auth/session', other.token)).status).toBe(401)
    expect((await send('GET', '/api/auth/session', bob.session)).status).toBe(200)
  },

  async 'GET /api/auth/tokens'() {
    const ids = await tokenIds(bob.session)
    for (const id of [alice.signedIn.tokenId, alice.apiId, alice.grantId]) expect(ids).not.toContain(id)
    expect(ids).toContain(bob.apiId)
  },

  async 'POST /api/auth/tokens'() {
    const { info } = await mint(bob.session, 'Bob gate')
    expect(await tokenIds(bob.session)).toContain(info.id)
    expect(await tokenIds(alice.session)).not.toContain(info.id)
  },

  async 'DELETE /api/auth/tokens/:id'() {
    const oauthTokenId = ctx.tokens.verify(alice.access)!.id
    for (const id of [alice.signedIn.tokenId, alice.apiId, alice.grantId, oauthTokenId]) {
      expect((await send('DELETE', `/api/auth/tokens/${id}`, bob.session)).status).toBe(404)
    }
  },

  async 'GET /api/gate'() {
    const elsewhere = await gate(bob.api, ALICE_REPO, 'feature/ledger')
    expect(elsewhere).toMatchObject({ pass: true, reasons: [`${ALICE_REPO} is not in Code Ducky; nothing to check.`] })
    const shared = await gate(bob.api, REPO, 'feature/tax')
    expect(shared.pass).toBe(true)
    expect(JSON.stringify(shared)).not.toContain('Alice')
  },

  async 'POST /api/channel/stream'() {
    const res = await send('POST', '/api/channel/stream', bob.api, registration(SHARED_CHANNEL, 'bob desktop'))
    expect(res.status).toBe(200)
    const stream = sseReader(res)
    streams.push(stream)
    expect(await stream.next()).toEqual({ event: 'ready', data: { id: SHARED_CHANNEL, heartbeatMs: 50 } })
    const task = await send('POST', `/api/channel/sessions/${SHARED_CHANNEL}/tasks`, bob.session, { kind: 'review', target: { repo: ALICE_REPO, branch: 'b' } })
    expect(task.status).toBe(200)
    expect((await nextEvent(stream)).event).toBe('task')
  },

  async 'POST /api/channel/sessions/:id/events'() {
    const events = `/api/channel/sessions/${ALICE_PRIVATE}/events`
    expect((await send('POST', events, bob.api, { type: 'status', taskId: alice.taskId, state: 'done' })).status).toBe(404)
    expect((await send('POST', events, bob.api, { type: 'delivered', taskId: alice.taskId })).status).toBe(404)
    expect((await send('POST', events, bob.api, { type: 'update', label: 'taken' })).status).toBe(404)
    const prompt = { type: 'permission_request', requestId: 'zzzzz', toolName: 'Bash', description: '', inputPreview: '' }
    expect((await send('POST', events, bob.api, prompt)).status).toBe(404)
    expect((await send('POST', events, bob.access, prompt)).status).toBe(404)
  },

  async 'DELETE /api/channel/sessions/:id'() {
    expect((await send('DELETE', `/api/channel/sessions/${ALICE_PRIVATE}`, bob.api)).status).toBe(404)
  },

  async 'GET /api/channel/sessions'() {
    const state = await json<ChannelState>(send('GET', '/api/channel/sessions', bob.session))
    expect(state.sessions.every((s) => s.label.startsWith('bob'))).toBe(true)
    expect(state.sessions.map((s) => s.id)).not.toContain(ALICE_PRIVATE)
    expect(state.permissions).toEqual([])
    expect(state.tasks.map((t) => t.id)).not.toContain(alice.taskId)
  },

  async 'GET /api/channel/events'() {
    const stream = sseReader(await send('GET', '/api/channel/events', bob.session))
    const { event, data } = await stream.next()
    await stream.close()
    expect(event).toBe('state')
    const state = data as ChannelState
    expect(state.sessions.map((s) => s.id)).not.toContain(ALICE_PRIVATE)
    expect(state.permissions).toEqual([])
    expect(state.sessions.map((s) => s.label).sort()).toEqual(['bob desktop', 'bob laptop'])
    expect(state.tasks.map((t) => t.id)).not.toContain(alice.taskId)
  },

  async 'POST /api/channel/sessions/:id/tasks'() {
    const target = { kind: 'review', target: { repo: ALICE_REPO, branch: 'feature/ledger' } }
    expect((await send('POST', `/api/channel/sessions/${ALICE_PRIVATE}/tasks`, bob.session, target)).status).toBe(404)
  },

  async 'POST /api/channel/sessions/:id/permissions/:requestId'() {
    for (const id of [ALICE_PRIVATE, SHARED_CHANNEL]) {
      expect((await send('POST', `/api/channel/sessions/${id}/permissions/abcde`, bob.session, { behavior: 'allow' })).status).toBe(404)
    }
  },

  async 'DELETE /api/account'() {
    expect((await send('DELETE', '/api/account', bob.session, { confirm: 'alice' })).status).toBe(400)
    const carol = await signInAs(ctx.app, 'carol')
    expect((await send('DELETE', '/api/account', carol.token, { confirm: 'carol' })).status).toBe(200)
    expect(getUser(ctx.db, carol.user.id)).toBeNull()
    expect(getUser(ctx.db, bob.signedIn.user.id)).not.toBeNull()
  },

  async 'ALL /mcp'() {
    const client = await mcpClient(ctx.app, bob.access)
    clients.push(client)
    expect(await callTool(client, 'get_note', { id: alice.mcpNoteId })).toEqual({ error: `No note with id ${alice.mcpNoteId}.` })
    const notes = (await callTool(client, 'list_notes', { status: 'all', allSessions: true })) as { notes: { body: string }[] }
    expect(notes.notes.map((n) => n.body)).toEqual(['Bob copy'])
    expect((await callTool(client, 'list_sessions', { repo: ALICE_REPO })).error).toContain('No repo matches')
  },

  async 'POST /oauth/authorize'() {
    const bobPage = await consent(bob.oauthClient, 'bob')
    const alicePage = await consent(alice.oauthClient, 'alice')
    const crossed = await decideConsent(appSend(ctx.app), TEST_ORIGIN, { flow: alicePage.flow, ticket: bobPage.ticket }, 'approve')
    expect(crossed.headers.get('location') ?? '').not.toContain('code=')
    const granted = await exchange(bob.oauthClient, await approve(bob.oauthClient, 'bob'))
    expect(ctx.tokens.verify(granted.body.access_token)?.userId).toBe(bob.signedIn.user.id)
  },

  async 'POST /oauth/token'() {
    const aliceCode = await approve(alice.oauthClient, 'alice')
    expect((await exchange(bob.oauthClient, aliceCode)).body.error).toBe('invalid_grant')
    const refreshed = await oauthToken({ grant_type: 'refresh_token', refresh_token: alice.refresh, client_id: bob.oauthClient })
    expect(refreshed.status).toBe(400)
    expect(((await refreshed.json()) as { error: string }).error).toBe('invalid_grant')
  },

  async 'POST /oauth/revoke'() {
    for (const token of [alice.access, alice.refresh]) {
      const res = await ctx.app.request(`${TEST_ORIGIN}/oauth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, client_id: bob.oauthClient }).toString(),
      })
      expect(res.status).toBe(200)
    }
  },
}

const routeKeys = () => [...new Set(ctx.app.routes.map((route) => `${route.method} ${route.path}`))].sort()
const classified = (kind: RouteClass) => Object.keys(ROUTES).filter((key) => ROUTES[key] === kind)

describe('route classification', () => {
  it('classifies every route the app mounts', () => {
    expect(routeKeys()).toEqual(Object.keys(ROUTES).sort())
  })

  it('has a cross-user case for every route that acts on a user\'s data', () => {
    expect(Object.keys(CROSS_USER).sort()).toEqual(classified('cross-user').sort())
  })
})

describe('bob against alice', () => {
  afterEach(async () => {
    expect(await aliceView()).toEqual(baseline as Awaited<ReturnType<typeof aliceView>>)
  })

  for (const [route, check] of Object.entries(CROSS_USER)) it(`${route} sees and changes only bob's data`, check)
})

describe('admin routes', () => {
  const adminCalls = () =>
    classified('admin')
      .filter((key) => !key.startsWith('ALL '))
      .map((key) => {
        const [method, path] = key.split(' ') as [string, string]
        return [method, path.replace(':id', alice.signedIn.user.id), method === 'PATCH' ? { records: 1 } : undefined] as const
      })

  it('refuse every user token, session or not', async () => {
    for (const [method, path, body] of adminCalls()) {
      for (const token of [bob.session, bob.api, bob.access]) expect((await send(method, path, token, body)).status, `${method} ${path}`).toBe(403)
    }
    expect(await aliceView()).toEqual(baseline as Awaited<ReturnType<typeof aliceView>>)
  })
})

describe('disable and delete cascades', () => {
  it('disabling bob ends his sessions, tokens, grants and channel streams, and leaves alice alone', async () => {
    const admin = await adminLogin(ctx.app)
    expect((await send('POST', `/api/admin/users/${bob.signedIn.user.id}/disable`, admin.token)).status).toBe(200)
    expect((await send('GET', '/api/auth/session', bob.session)).status).toBe(401)
    expect((await send('POST', '/api/sync', bob.session, { cursor: 0, changes: [] })).status).toBe(401)
    expect((await send('GET', `/api/gate?repo=${REPO}&branch=x`, bob.api)).status).toBe(401)
    expect(ctx.tokens.verify(bob.access)).toBeNull()
    expect((await ctx.app.request(`${TEST_ORIGIN}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${bob.access}` } })).status).toBe(401)
    await expect(
      (async () => {
        for (;;) await bob.plugin.next()
      })(),
    ).rejects.toThrow('stream ended')
    expect(ctx.channel.state(bob.signedIn.user.id)).toEqual({ sessions: [], tasks: [], permissions: [] })
    expect(await aliceView()).toEqual(baseline as Awaited<ReturnType<typeof aliceView>>)
  })

  it('deleting bob removes his records, which share ids with alice\'s, and leaves hers', async () => {
    const admin = await adminLogin(ctx.app)
    expect(readRecord(ctx.db, bob.signedIn.user.id, 'repos', REPO_ID)).not.toBeNull()
    expect((await send('DELETE', `/api/admin/users/${bob.signedIn.user.id}`, admin.token)).status).toBe(200)
    expect(getUser(ctx.db, bob.signedIn.user.id)).toBeNull()
    for (const [kind, id] of [['repos', REPO_ID], ['inbox', 'inbox'], ['notes', 'alice-n1']] as const) {
      expect(readRecord(ctx.db, bob.signedIn.user.id, kind, id)).toBeNull()
      expect(readRecord(ctx.db, alice.signedIn.user.id, kind, id)).not.toBeNull()
    }
    expect(await aliceView()).toEqual(baseline as Awaited<ReturnType<typeof aliceView>>)
  })
})
