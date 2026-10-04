import { afterEach, describe, expect, it } from 'bun:test'
import { createFailureLimiter } from './auth/passphrase'
import { createUserSession, login, makeApp, PASSPHRASE, request } from './testing'
import { ADMIN_USER_ID } from './users/store'

const cleanups: (() => void)[] = []
const setup = (...args: Parameters<typeof makeApp>) => {
  const made = makeApp(...args)
  cleanups.push(made.cleanup)
  return made
}
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

describe('auth', () => {
  it('signs in with the passphrase and stores only a hash of the token', async () => {
    const { app, db } = setup()
    const res = await request(app, 'POST', '/api/auth/login', { passphrase: PASSPHRASE, name: 'Laptop' })
    expect(res.status).toBe(200)
    const { token, tokenId } = (await res.json()) as { token: string; tokenId: string }
    expect(token).toStartWith('cdb_')
    const row = db.query<{ token_hash: string; name: string; kind: string }, [string]>('SELECT * FROM tokens WHERE id = ?').get(tokenId)!
    expect(row).toMatchObject({ name: 'Laptop', kind: 'session' })
    expect(row.token_hash).not.toContain(token)
    expect(row.token_hash).toHaveLength(64)

    const session = await request(app, 'GET', '/api/auth/session', undefined, token)
    expect(await session.json()).toEqual({ tokenId, name: 'Laptop', kind: 'session', user: { id: ADMIN_USER_ID, login: 'admin', role: 'admin' } })
  })

  it('refuses a wrong passphrase and requests without a valid token', async () => {
    const { app } = setup()
    expect((await request(app, 'POST', '/api/auth/login', { passphrase: 'nope' })).status).toBe(401)
    expect((await request(app, 'POST', '/api/auth/login', {})).status).toBe(401)
    expect((await request(app, 'GET', '/api/auth/session')).status).toBe(401)
    expect((await request(app, 'GET', '/api/auth/session', undefined, 'cdb_forged')).status).toBe(401)
    expect((await request(app, 'POST', '/api/sync', { cursor: 0, changes: [] })).status).toBe(401)
  })

  it('rate-limits failed sign-ins per client, and lets the window expire', async () => {
    let now = 1_000_000
    const limiter = createFailureLimiter({ perClient: 3, global: 50, windowMs: 60_000, now: () => now })
    const { app } = setup({ limiter })
    const attempt = (passphrase: string, ip = '10.0.0.1') =>
      app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
        body: JSON.stringify({ passphrase }),
      })
    for (let i = 0; i < 3; i++) expect((await attempt('wrong')).status).toBe(401)
    const blocked = await attempt(PASSPHRASE)
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect((await attempt(PASSPHRASE, '10.0.0.2')).status).toBe(200)
    now += 60_001
    expect((await attempt(PASSPHRASE)).status).toBe(200)
  })

  it('applies a global limit across client addresses', async () => {
    const limiter = createFailureLimiter({ perClient: 100, global: 4, windowMs: 60_000 })
    const { app } = setup({ limiter })
    for (let i = 0; i < 4; i++) {
      await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.1.${i}` },
        body: JSON.stringify({ passphrase: 'wrong' }),
      })
    }
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.2.1' },
      body: JSON.stringify({ passphrase: PASSPHRASE }),
    })
    expect(res.status).toBe(429)
  })

  it('mints, lists and revokes named tokens', async () => {
    const { app } = setup()
    const owner = await login(app, 'Laptop')
    const minted = await request(app, 'POST', '/api/auth/tokens', { name: 'Claude Code' }, owner)
    expect(minted.status).toBe(200)
    const { token: apiToken, info } = (await minted.json()) as { token: string; info: { id: string; kind: string } }
    expect(info.kind).toBe('api')

    const list = (await (await request(app, 'GET', '/api/auth/tokens', undefined, owner)).json()) as {
      tokens: { id: string; name: string; current: boolean; lastUsedAt: number | null }[]
    }
    expect(list.tokens.map((t) => t.name).sort()).toEqual(['Claude Code', 'Laptop'])
    expect(list.tokens.find((t) => t.current)?.name).toBe('Laptop')
    expect(JSON.stringify(list)).not.toContain(apiToken)

    expect((await request(app, 'POST', '/api/sync', { cursor: 0, changes: [] }, apiToken)).status).toBe(200)
    expect((await request(app, 'GET', '/api/auth/tokens', undefined, apiToken)).status).toBe(403)
    expect((await request(app, 'POST', '/api/auth/tokens', { name: '' }, owner)).status).toBe(400)

    expect((await request(app, 'DELETE', `/api/auth/tokens/${info.id}`, undefined, owner)).status).toBe(200)
    expect((await request(app, 'POST', '/api/sync', { cursor: 0, changes: [] }, apiToken)).status).toBe(401)
    expect((await request(app, 'DELETE', `/api/auth/tokens/${info.id}`, undefined, owner)).status).toBe(404)
  })

  it('signs out by revoking the current token', async () => {
    const { app } = setup()
    const token = await login(app)
    expect((await request(app, 'POST', '/api/auth/logout', undefined, token)).status).toBe(200)
    expect((await request(app, 'GET', '/api/auth/session', undefined, token)).status).toBe(401)
  })

  it('expires tokens issued with an expiry, through the same validation', () => {
    let now = 5_000
    const { tokens } = setup({ now: () => now })
    const { token } = tokens.issue({ userId: ADMIN_USER_ID, name: 'oauth client', kind: 'oauth', expiresAt: 10_000, clientId: 'c1' })
    expect(tokens.verify(token)).toMatchObject({ kind: 'oauth', clientId: 'c1', lastUsedAt: 5_000 })
    now = 10_000
    expect(tokens.verify(token)).toBeNull()
    expect(tokens.list(ADMIN_USER_ID)).toHaveLength(0)
  })

  it('returns the admin account from the passphrase sign-in', async () => {
    const { app } = setup()
    const res = await request(app, 'POST', '/api/auth/login', { passphrase: PASSPHRASE })
    expect(((await res.json()) as { user: unknown }).user).toEqual({ id: ADMIN_USER_ID, login: 'admin', role: 'admin' })
  })

  it('lists, mints and revokes only the signed-in user\'s tokens and grants', async () => {
    const { app, db, oauth } = setup()
    const alice = createUserSession(db, 'alice', 'Alice laptop')
    const bob = createUserSession(db, 'bob', 'Bob laptop')
    const minted = (await (await request(app, 'POST', '/api/auth/tokens', { name: 'Alice CLI' }, alice.token)).json()) as {
      token: string
      info: { id: string; userId: string }
    }
    expect(minted.info.userId).toBe(alice.user.id)
    const { client } = oauth.registerClient({ name: 'Alice MCP', redirectUris: ['http://localhost/cb'], authMethod: 'none', grantTypes: ['authorization_code'] })
    const code = oauth.consumeCode(
      oauth.createCode({ userId: alice.user.id, clientId: client.id, redirectUri: 'http://localhost/cb', codeChallenge: 'x', scope: 'codeducky', resource: 'r' }),
    )!
    const { accessToken } = oauth.createGrant(client, code)
    const grantId = oauth.listGrants(alice.user.id)[0]!.id

    const names = async (token: string) =>
      ((await (await request(app, 'GET', '/api/auth/tokens', undefined, token)).json()) as { tokens: { name: string }[] }).tokens
        .map((t) => t.name)
        .sort()
    expect(await names(alice.token)).toEqual(['Alice CLI', 'Alice MCP', 'Alice laptop'])
    expect(await names(bob.token)).toEqual(['Bob laptop'])

    for (const id of [minted.info.id, grantId, alice.user.id]) {
      expect((await request(app, 'DELETE', `/api/auth/tokens/${id}`, undefined, bob.token)).status).toBe(404)
    }
    expect((await request(app, 'GET', '/api/auth/session', undefined, minted.token)).status).toBe(200)
    expect((await request(app, 'GET', '/api/auth/session', undefined, accessToken)).status).toBe(200)

    expect((await request(app, 'DELETE', `/api/auth/tokens/${grantId}`, undefined, alice.token)).status).toBe(200)
    expect((await request(app, 'GET', '/api/auth/session', undefined, accessToken)).status).toBe(401)
  })

  it('scopes the session to its user and refuses tokens of a disabled user', async () => {
    const { app, db } = setup()
    const alice = createUserSession(db, 'alice')
    const session = await request(app, 'GET', '/api/auth/session', undefined, alice.token)
    expect(((await session.json()) as { user: unknown }).user).toEqual({ id: alice.user.id, login: 'alice', role: 'user' })

    db.query("UPDATE users SET status = 'disabled' WHERE id = ?").run(alice.user.id)
    expect((await request(app, 'GET', '/api/auth/session', undefined, alice.token)).status).toBe(401)
    expect((await request(app, 'POST', '/api/sync', { cursor: 0, changes: [] }, alice.token)).status).toBe(401)
  })
})
