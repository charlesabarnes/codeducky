import { afterEach, describe, expect, it } from 'bun:test'
import { pairId, type SyncResponse, type WireChange } from '../shared/sync'
import { parseQuotaOverride } from './admin/routes'
import { createFlowStore } from './auth/flows'
import { createChannelRegistry, type ChannelOwner, type Registration } from './channel/registry'
import { readRecord } from './records/store'
import { adminLogin, createUserSession, makeApp, request } from './testing'
import { ADMIN_USER_ID, getUser } from './users/store'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

const REDIRECT = 'http://localhost/cb'

const registration = (id = 'plugin-session-0001'): Registration => ({
  id,
  label: 'repo on laptop',
  cwd: '/src/repo',
  repo: 'acme/repo',
  branch: 'main',
  hostname: 'laptop',
  pluginVersion: '0.1.0',
})

async function setup() {
  const made = makeApp({ channel: createChannelRegistry({ heartbeatMs: 50 }) })
  cleanups.push(made.cleanup)
  const admin = await adminLogin(made.app)
  const alice = createUserSession(made.db, 'alice')
  const bob = createUserSession(made.db, 'bob')
  const send = (method: string, path: string, token: string, body?: unknown) => request(made.app, method, path, body, token)
  const mintApiToken = async (session: string) => {
    const res = await send('POST', '/api/auth/tokens', session, { name: 'Claude' })
    return (await res.json()) as { token: string; info: { id: string; name: string } }
  }
  const approveClient = (userId: string) => {
    const { client } = made.oauth.registerClient({
      name: 'MCP',
      redirectUris: [REDIRECT],
      authMethod: 'none',
      grantTypes: ['authorization_code', 'refresh_token'],
    })
    const code = () =>
      made.oauth.createCode({ userId, clientId: client.id, redirectUri: REDIRECT, codeChallenge: 'x', scope: 'codeducky', resource: 'r' })
    const issued = made.oauth.createGrant(client, made.oauth.consumeCode(code())!)
    return { client, issued, pendingCode: code() }
  }
  const push = async (token: string, changes: WireChange[]) => {
    const res = await send('POST', '/api/sync', token, { cursor: 0, changes })
    expect(res.status).toBe(200)
    return (await res.json()) as SyncResponse
  }
  const users = async () => {
    const res = await send('GET', '/api/admin/users', admin.token)
    expect(res.status).toBe(200)
    return ((await res.json()) as { users: Summary[] }).users
  }
  return { ...made, admin, alice, bob, send, mintApiToken, approveClient, push, users }
}

const view = (path: string, hash = 'h'): WireChange => ({
  kind: 'fileViews',
  id: pairId('s1', path),
  changedAt: 1,
  deleted: false,
  data: { sessionId: 's1', path, contentHash: hash, viewed: true },
})

interface Summary {
  id: string
  login: string
  role: string
  status: string
  usage: { records: number; bytes: number }
  quota: { records: number; bytes: number }
  override: { records: number | null; bytes: number | null }
  tokens: { session: number; api: number; oauth: number }
  grants: number
  channelSessions: number
}

function pluginSink() {
  let open = true
  return { sink: () => open, close: () => (open = false) }
}

describe('admin access', () => {
  it('serves only the admin session; users, API tokens and anonymous requests are refused', async () => {
    const { send, admin, alice, mintApiToken, tokens } = await setup()
    const routes: [string, string, unknown?][] = [
      ['GET', '/api/admin/users'],
      ['GET', '/api/admin/stats'],
      ['POST', `/api/admin/users/${alice.user.id}/disable`],
      ['POST', `/api/admin/users/${alice.user.id}/enable`],
      ['PATCH', `/api/admin/users/${alice.user.id}/quota`, { records: 5 }],
      ['DELETE', `/api/admin/users/${alice.user.id}`],
    ]
    const aliceApi = (await mintApiToken(alice.token)).token
    // The admin cannot mint API tokens; one is planted to show the token kind is checked regardless.
    const adminApi = tokens.issue({ userId: ADMIN_USER_ID, name: 'planted', kind: 'api' }).token
    for (const [method, path, body] of routes) {
      expect((await send(method, path, alice.token, body)).status, `${method} ${path} as a user`).toBe(403)
      expect((await send(method, path, aliceApi, body)).status, `${method} ${path} with an API token`).toBe(403)
      expect((await send(method, path, adminApi, body)).status, `${method} ${path} with an admin API token`).toBe(403)
      expect((await send(method, path, '', body)).status, `${method} ${path} signed out`).toBe(401)
    }
    expect((await send('GET', '/api/admin/users', admin.token)).status).toBe(200)
    expect((await send('GET', '/api/admin/stats', admin.token)).status).toBe(200)
  })
})

describe('admin user list and stats', () => {
  it('reports usage, quota, token and grant counts and connected sessions, never record contents', async () => {
    const { alice, bob, push, mintApiToken, approveClient, channel, users } = await setup()
    await push(alice.token, [view('secret-path.ts', 'SECRET-CONTENT')])
    const api = await mintApiToken(alice.token)
    approveClient(alice.user.id)
    const owner: ChannelOwner = { userId: alice.user.id, tokenId: api.info.id, grantId: null, tokenName: 'Claude' }
    channel.connect(registration(), owner, pluginSink().sink)

    const list = await users()
    expect(list.map((u) => u.login)).toEqual(['admin', 'alice', 'bob'])
    const summary = list.find((u) => u.id === alice.user.id)!
    expect(summary).toMatchObject({
      role: 'user',
      status: 'active',
      usage: { records: 1 },
      override: { records: null, bytes: null },
      tokens: { session: 1, api: 1, oauth: 1 },
      grants: 1,
      channelSessions: 1,
    })
    expect(summary.usage.bytes).toBeGreaterThan(0)
    expect(summary.quota.records).toBeGreaterThan(0)
    expect(list.find((u) => u.id === bob.user.id)).toMatchObject({ tokens: { session: 1, api: 0, oauth: 0 }, grants: 0, channelSessions: 0 })
    const raw = JSON.stringify(list)
    expect(raw).not.toContain('SECRET-CONTENT')
    expect(raw).not.toContain('secret-path')
  })

  it('counts accounts, recent signups and the database size', async () => {
    const { send, admin } = await setup()
    const res = await send('GET', '/api/admin/stats', admin.token)
    const stats = (await res.json()) as Record<string, unknown>
    expect(stats).toMatchObject({ users: 2, disabled: 0, signupsLastDay: 2, signupsOpen: true, maxUsers: null })
    expect(stats.dbBytes).toBeGreaterThan(0)
  })
})

describe('disabling an account', () => {
  it('revokes tokens, grants and codes, drops channel sessions and pending sign-ins, and leaves others alone', async () => {
    const { db, send, admin, alice, bob, mintApiToken, approveClient, channel, tokens, oauth, users } = await setup()
    const api = await mintApiToken(alice.token)
    const { client, issued, pendingCode } = approveClient(alice.user.id)
    channel.connect(registration(), { userId: alice.user.id, tokenId: api.info.id, grantId: null, tokenName: 'Claude' }, pluginSink().sink)
    channel.connect(registration(), { userId: bob.user.id, tokenId: 'bob-token', grantId: null, tokenName: 'Claude' }, pluginSink().sink)
    const flows = createFlowStore(db)
    const handoff = flows.createHandoff(alice.user.id, 'challenge')

    const res = await send('POST', `/api/admin/users/${alice.user.id}/disable`, admin.token)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { user: Summary }).user).toMatchObject({
      status: 'disabled',
      tokens: { session: 0, api: 0, oauth: 0 },
      grants: 0,
      channelSessions: 0,
    })

    expect((await send('GET', '/api/auth/session', alice.token)).status).toBe(401)
    expect(tokens.verify(api.token)).toBeNull()
    expect(tokens.verify(issued.accessToken)).toBeNull()
    expect(oauth.refresh(issued.refreshToken, client)).toEqual({ error: 'invalid' })
    expect(oauth.consumeCode(pendingCode)).toBeNull()
    expect(db.query('SELECT 1 FROM auth_handoffs WHERE user_id = ?').all(alice.user.id)).toEqual([])
    expect(flows.consumeHandoff(handoff, 'anything')).toBeNull()
    expect(channel.state(alice.user.id).sessions).toEqual([])

    expect((await send('GET', '/api/auth/session', bob.token)).status).toBe(200)
    expect(channel.state(bob.user.id).sessions).toHaveLength(1)
    expect((await users()).find((u) => u.id === bob.user.id)?.status).toBe('active')
  })

  it('ends an open PWA event stream at its next heartbeat', async () => {
    const { send, admin, alice } = await setup()
    const res = await send('GET', '/api/channel/events', alice.token)
    const reader = res.body!.getReader()
    await reader.read()
    await send('POST', `/api/admin/users/${alice.user.id}/disable`, admin.token)
    const ended = (async () => {
      for (;;) if ((await reader.read()).done) return true
    })()
    expect(await Promise.race([ended, Bun.sleep(1000).then(() => false)])).toBe(true)
  })

  it('lets the account back in once enabled, through a new sign-in', async () => {
    const { db, send, admin, alice, users } = await setup()
    await send('POST', `/api/admin/users/${alice.user.id}/disable`, admin.token)
    const res = await send('POST', `/api/admin/users/${alice.user.id}/enable`, admin.token)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { user: Summary }).user.status).toBe('active')
    expect((await users()).find((u) => u.id === alice.user.id)?.status).toBe('active')
    // Disabling revoked the old session for good.
    expect((await send('GET', '/api/auth/session', alice.token)).status).toBe(401)
    const again = createUserSession(db, 'alice')
    expect((await send('GET', '/api/auth/session', again.token)).status).toBe(200)
  })
})

describe('deleting accounts', () => {
  it('deletes a user with their records and tokens, and refuses the admin account', async () => {
    const { db, send, admin, alice, bob, push, channel } = await setup()
    await push(alice.token, [view('a.ts')])
    await push(bob.token, [view('a.ts')])
    channel.connect(registration(), { userId: alice.user.id, tokenId: 't', grantId: null, tokenName: 'Claude' }, pluginSink().sink)

    expect((await send('DELETE', `/api/admin/users/${ADMIN_USER_ID}`, admin.token)).status).toBe(400)
    expect((await send('POST', `/api/admin/users/${ADMIN_USER_ID}/disable`, admin.token)).status).toBe(400)
    expect((await send('DELETE', '/api/admin/users/nobody', admin.token)).status).toBe(404)

    expect((await send('DELETE', `/api/admin/users/${alice.user.id}`, admin.token)).status).toBe(200)
    expect(getUser(db, alice.user.id)).toBeNull()
    expect(readRecord(db, alice.user.id, 'fileViews', pairId('s1', 'a.ts'))).toBeNull()
    expect(readRecord(db, bob.user.id, 'fileViews', pairId('s1', 'a.ts'))).not.toBeNull()
    expect((await send('GET', '/api/auth/session', alice.token)).status).toBe(401)
    expect(channel.state(alice.user.id).sessions).toEqual([])
    expect((await send('GET', '/api/auth/session', admin.token)).status).toBe(200)
  })
})

describe('quota overrides', () => {
  it('applies an override to sync, and clears it with null', async () => {
    const { send, admin, alice, push } = await setup()
    const set = (body: unknown) => send('PATCH', `/api/admin/users/${alice.user.id}/quota`, admin.token, body)
    const res = await set({ records: 1 })
    expect(res.status).toBe(200)
    const { user } = (await res.json()) as { user: Summary }
    expect(user.override).toEqual({ records: 1, bytes: null })
    expect(user.quota.records).toBe(1)

    expect((await push(alice.token, [view('a'), view('b')])).rejected).toEqual([
      { kind: 'fileViews', id: pairId('s1', 'b'), error: 'quota_exceeded' },
    ])
    const session = (await (await send('GET', '/api/auth/session', alice.token)).json()) as { quota: { records: number } }
    expect(session.quota.records).toBe(1)

    expect((await set({ records: null })).status).toBe(200)
    expect((await push(alice.token, [view('b')])).rejected).toEqual([])
  })

  it('validates the body', async () => {
    const { send, admin, alice } = await setup()
    const set = (body: unknown) => send('PATCH', `/api/admin/users/${alice.user.id}/quota`, admin.token, body)
    for (const body of [{}, { records: 0 }, { records: -1 }, { bytes: 1.5 }, { bytes: '10' }, null]) {
      expect((await set(body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(parseQuotaOverride({ records: 10, other: 1 })).toEqual({ records: 10 })
    expect(parseQuotaOverride({ bytes: null })).toEqual({ bytes: null })
  })
})

describe('DELETE /api/account', () => {
  it('deletes the signed-in user after they type their login, with everything they own', async () => {
    const { db, send, alice, bob, push, mintApiToken, approveClient, channel, tokens } = await setup()
    await push(alice.token, [view('a.ts')])
    const api = await mintApiToken(alice.token)
    const { issued } = approveClient(alice.user.id)
    channel.connect(registration(), { userId: alice.user.id, tokenId: api.info.id, grantId: null, tokenName: 'Claude' }, pluginSink().sink)

    expect((await send('DELETE', '/api/account', alice.token, { confirm: 'bob' })).status).toBe(400)
    expect((await send('DELETE', '/api/account', alice.token)).status).toBe(400)
    expect((await send('DELETE', '/api/account', api.token, { confirm: 'alice' })).status).toBe(403)
    expect(getUser(db, alice.user.id)).not.toBeNull()

    expect((await send('DELETE', '/api/account', alice.token, { confirm: 'alice' })).status).toBe(200)
    expect(getUser(db, alice.user.id)).toBeNull()
    expect(readRecord(db, alice.user.id, 'fileViews', pairId('s1', 'a.ts'))).toBeNull()
    expect(tokens.verify(api.token)).toBeNull()
    expect(tokens.verify(issued.accessToken)).toBeNull()
    expect(channel.state(alice.user.id).sessions).toEqual([])
    expect((await send('GET', '/api/auth/session', alice.token)).status).toBe(401)
    expect((await send('GET', '/api/auth/session', bob.token)).status).toBe(200)
  })

  it('is not offered to the admin account', async () => {
    const { send, admin } = await setup()
    expect((await send('DELETE', '/api/account', admin.token, { confirm: 'admin' })).status).toBe(403)
  })
})
