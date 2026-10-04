import { afterEach, describe, expect, it } from 'bun:test'
import { CLIENT_GRACE_MS, ClientLimitError, createOAuthStore, MAX_CLIENTS, MAX_GRANTS, type OAuthClient } from './auth/oauth/store'
import { createTokenStore, MAX_API_TOKENS, MAX_SESSIONS } from './auth/tokens'
import { createUserSession, makeApp, request } from './testing'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

function setup() {
  const made = makeApp()
  cleanups.push(made.cleanup)
  const alice = createUserSession(made.db, 'alice')
  const bob = createUserSession(made.db, 'bob')
  const start = Date.now()
  let at = start
  const now = () => at
  const tokens = createTokenStore(made.db, now)
  const oauth = createOAuthStore(made.db, tokens, now)
  return { ...made, tokens, oauth, alice, bob, start, advance: (ms: number) => (at += ms) }
}

describe('device sessions', () => {
  it('keeps the newest sessions per user and evicts the oldest', () => {
    const { tokens, alice, bob, advance } = setup()
    const issued = Array.from({ length: MAX_SESSIONS + 1 }, (_, i) => {
      advance(1)
      return tokens.issue({ userId: alice.user.id, name: `device ${i}`, kind: 'session' }).token
    })
    expect(tokens.countByKind(alice.user.id, 'session')).toBe(MAX_SESSIONS)
    expect(tokens.verify(alice.token)).toBeNull()
    expect(tokens.verify(issued[0]!)).toBeNull()
    expect(tokens.verify(issued[1]!)).not.toBeNull()
    expect(tokens.verify(issued.at(-1)!)).not.toBeNull()
    expect(tokens.verify(bob.token)).not.toBeNull()
  })
})

describe('API tokens', () => {
  it('refuses a new token past the cap with 409 token_limit', async () => {
    const { app, alice, bob } = setup()
    const mint = (token: string, name: string) => request(app, 'POST', '/api/auth/tokens', { name }, token)
    for (let i = 0; i < MAX_API_TOKENS; i++) expect((await mint(alice.token, `t${i}`)).status).toBe(200)
    const refused = await mint(alice.token, 'one more')
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: 'token_limit' })
    expect((await mint(bob.token, 'bob')).status).toBe(200)
  })
})

describe('token store', () => {
  it('counts unexpired tokens by kind and revokes all of a user\'s tokens', () => {
    const { tokens, alice, bob, start, advance } = setup()
    tokens.issue({ userId: alice.user.id, name: 'cli', kind: 'api' })
    tokens.issue({ userId: alice.user.id, name: 'short', kind: 'api', expiresAt: start + 10 })
    expect(tokens.countByKind(alice.user.id, 'api')).toBe(2)
    advance(10)
    expect(tokens.countByKind(alice.user.id, 'api')).toBe(1)

    expect(tokens.revokeAllForUser(alice.user.id)).toBe(3)
    expect(tokens.countByKind(alice.user.id, 'session')).toBe(0)
    expect(tokens.verify(alice.token)).toBeNull()
    expect(tokens.verify(bob.token)).not.toBeNull()
  })
})

describe('OAuth grants', () => {
  it('revokes the oldest grant when a user approves one past the cap', () => {
    const { oauth, tokens, alice, bob, advance } = setup()
    const { client } = oauth.registerClient({ name: 'MCP', redirectUris: ['http://localhost/cb'], authMethod: 'none', grantTypes: ['authorization_code'] })
    const grant = (userId: string) => {
      advance(1)
      const code = oauth.consumeCode(
        oauth.createCode({ userId, clientId: client.id, redirectUri: 'http://localhost/cb', codeChallenge: 'x', scope: 'codeducky', resource: 'r' }),
      )!
      return oauth.createGrant(client, code).accessToken
    }
    const bobs = grant(bob.user.id)
    const first = grant(alice.user.id)
    for (let i = 0; i < MAX_GRANTS; i++) grant(alice.user.id)
    expect(oauth.listGrants(alice.user.id)).toHaveLength(MAX_GRANTS)
    expect(tokens.verify(first)).toBeNull()
    expect(tokens.verify(bobs)).not.toBeNull()
  })
})

describe('revokeUserGrants', () => {
  it('revokes every grant of the user, and only theirs', () => {
    const { oauth, tokens, alice, bob } = setup()
    const { client } = oauth.registerClient({ name: 'MCP', redirectUris: ['http://localhost/cb'], authMethod: 'none', grantTypes: ['authorization_code'] })
    const grant = (userId: string) =>
      oauth.createGrant(
        client,
        oauth.consumeCode(
          oauth.createCode({ userId, clientId: client.id, redirectUri: 'http://localhost/cb', codeChallenge: 'x', scope: 'codeducky', resource: 'r' }),
        )!,
      )
    const alices = grant(alice.user.id)
    const bobs = grant(bob.user.id)
    expect(oauth.revokeUserGrants(alice.user.id)).toBe(1)
    expect(tokens.verify(alices.accessToken)).toBeNull()
    expect(oauth.refresh(alices.refreshToken, client)).toEqual({ error: 'invalid' })
    expect(tokens.verify(bobs.accessToken)).not.toBeNull()
  })
})

describe('client registration', () => {
  const register = (oauth: ReturnType<typeof setup>['oauth'], name: string): OAuthClient =>
    oauth.registerClient({ name, redirectUris: ['http://localhost/cb'], authMethod: 'none', grantTypes: ['authorization_code'] }).client

  function fill(db: ReturnType<typeof setup>['db'], count: number, createdAt: number) {
    const insert = db.query(
      `INSERT INTO oauth_clients (id, secret_hash, name, redirect_uris, auth_method, grant_types, created_at)
       VALUES (?, NULL, 'bulk', '[]', 'none', '["authorization_code"]', ?)`,
    )
    db.transaction(() => {
      for (let i = 0; i < count; i++) insert.run(`bulk-${createdAt}-${i}`, createdAt)
    })()
  }

  it('prunes unused clients older than a day first, keeping recent ones mid sign-in', () => {
    const { oauth, db, start, advance } = setup()
    fill(db, 10, start)
    advance(CLIENT_GRACE_MS)
    fill(db, MAX_CLIENTS - 10, start + CLIENT_GRACE_MS)
    register(oauth, 'new')
    const count = (createdAt: number) =>
      db.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM oauth_clients WHERE created_at = ?').get(createdAt)!.n
    expect(count(start)).toBe(0)
    expect(count(start + CLIENT_GRACE_MS)).toBe(MAX_CLIENTS - 9)
  })

  it('falls back to the oldest unused clients when none is past the grace period', () => {
    const { oauth, db, start } = setup()
    fill(db, MAX_CLIENTS, start)
    const kept = register(oauth, 'new')
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM oauth_clients').get()!.n).toBe(MAX_CLIENTS)
    expect(oauth.getClient(kept.id)).not.toBeNull()
  })

  it('keeps clients with a pending authorization code', () => {
    const { oauth, db, start, advance } = setup()
    const pending = register(oauth, 'mid sign-in')
    fill(db, MAX_CLIENTS - 1, start + 1)
    advance(CLIENT_GRACE_MS + 10)
    oauth.createCode({ userId: 'admin', clientId: pending.id, redirectUri: 'http://localhost/cb', codeChallenge: 'x', scope: 'codeducky', resource: 'r' })
    register(oauth, 'new')
    expect(oauth.getClient(pending.id)).not.toBeNull()
  })

  it('refuses registration with 503 when no client can be pruned', async () => {
    const { app, oauth, db, alice } = setup()
    const used = register(oauth, 'used')
    oauth.createGrant(
      used,
      oauth.consumeCode(
        oauth.createCode({ userId: alice.user.id, clientId: used.id, redirectUri: 'http://localhost/cb', codeChallenge: 'x', scope: 'codeducky', resource: 'r' }),
      )!,
    )
    fill(db, MAX_CLIENTS - 1, 1)
    db.query("INSERT INTO oauth_grants (id, user_id, client_id, refresh_hash, scope, resource, created_at, refreshed_at, expires_at) SELECT 'g-' || id, ?, id, 'h-' || id, 'codeducky', 'r', 1, 1, ? FROM oauth_clients WHERE name = 'bulk'").run(
      alice.user.id,
      Date.now() + 86_400_000,
    )
    expect(() => register(oauth, 'one more')).toThrow(ClientLimitError)
    const res = await request(app, 'POST', '/oauth/register', { redirect_uris: ['http://localhost/cb'], token_endpoint_auth_method: 'none' })
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('3600')
  })
})
