import type { Database } from 'bun:sqlite'
import { randomBytes, randomUUID } from 'node:crypto'
import { hashToken, passphraseMatches } from '../passphrase'
import type { TokenStore } from '../tokens'

export const ACCESS_TOKEN_TTL_MS = 60 * 60_000
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60_000
export const CODE_TTL_MS = 5 * 60_000
/** Registration is unauthenticated, so unused clients are pruned past this many. */
export const MAX_CLIENTS = 200

export type ClientAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic'
export type GrantType = 'authorization_code' | 'refresh_token'

export interface OAuthClient {
  id: string
  name: string
  redirectUris: string[]
  authMethod: ClientAuthMethod
  grantTypes: GrantType[]
  createdAt: number
  secretHash: string | null
}

export interface AuthorizationCode {
  clientId: string
  redirectUri: string
  codeChallenge: string
  scope: string
  resource: string
}

export interface Grant {
  id: string
  clientId: string
  scope: string
  resource: string
  createdAt: number
  refreshedAt: number
  expiresAt: number
}

export interface IssuedTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
  scope: string
}

export type RefreshResult = { tokens: IssuedTokens; grant: Grant } | { error: 'invalid' | 'reused' }

interface ClientRow {
  id: string
  secret_hash: string | null
  name: string
  redirect_uris: string
  auth_method: ClientAuthMethod
  grant_types: string
  created_at: number
}

interface GrantRow {
  id: string
  client_id: string
  scope: string
  resource: string
  created_at: number
  refreshed_at: number
  expires_at: number
}

const toClient = (row: ClientRow): OAuthClient => ({
  id: row.id,
  name: row.name,
  redirectUris: JSON.parse(row.redirect_uris) as string[],
  authMethod: row.auth_method,
  grantTypes: JSON.parse(row.grant_types) as GrantType[],
  createdAt: row.created_at,
  secretHash: row.secret_hash,
})

const toGrant = (row: GrantRow): Grant => ({
  id: row.id,
  clientId: row.client_id,
  scope: row.scope,
  resource: row.resource,
  createdAt: row.created_at,
  refreshedAt: row.refreshed_at,
  expiresAt: row.expires_at,
})

const secretValue = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`
const GRANT_COLUMNS = 'id, client_id, scope, resource, created_at, refreshed_at, expires_at'

/**
 * Registered clients, authorization codes and grants. A grant is one approval on the consent
 * page: it holds the current refresh token, and every access token it mints is a row in the
 * shared token table tagged with its id, so revoking the grant revokes them all.
 */
export function createOAuthStore(db: Database, tokens: TokenStore, now: () => number = Date.now) {
  const getClient = (id: string): OAuthClient | null => {
    const row = db.query<ClientRow, [string]>('SELECT * FROM oauth_clients WHERE id = ?').get(id)
    return row ? toClient(row) : null
  }

  const getGrant = (id: string): Grant | null => {
    const row = db.query<GrantRow, [string]>(`SELECT ${GRANT_COLUMNS} FROM oauth_grants WHERE id = ?`).get(id)
    return row ? toGrant(row) : null
  }

  const revokeGrant = (id: string): boolean => {
    tokens.revokeGrant(id)
    return db.query('DELETE FROM oauth_grants WHERE id = ?').run(id).changes > 0
  }

  /** Replaces the grant's access token and refresh token. */
  const mint = (grant: Grant, client: OAuthClient): IssuedTokens => {
    tokens.revokeGrant(grant.id)
    const { token } = tokens.issue({
      name: client.name,
      kind: 'oauth',
      clientId: client.id,
      scope: grant.scope,
      grantId: grant.id,
      expiresAt: now() + ACCESS_TOKEN_TTL_MS,
    })
    const refreshToken = secretValue('cdr_')
    db.query(
      `UPDATE oauth_grants SET previous_refresh_hash = refresh_hash, refresh_hash = ?, refreshed_at = ?, expires_at = ?
       WHERE id = ?`,
    ).run(hashToken(refreshToken), now(), now() + REFRESH_TOKEN_TTL_MS, grant.id)
    return { accessToken: token, refreshToken, expiresIn: ACCESS_TOKEN_TTL_MS / 1000, scope: grant.scope }
  }

  const pruneClients = () => {
    db.query('DELETE FROM oauth_codes WHERE expires_at <= ?').run(now())
    for (const { id } of db.query<{ id: string }, [number]>('SELECT id FROM oauth_grants WHERE expires_at <= ?').all(now())) {
      revokeGrant(id)
    }
    const count = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM oauth_clients').get()!.n
    if (count < MAX_CLIENTS) return
    db.query(
      `DELETE FROM oauth_clients WHERE id NOT IN (SELECT client_id FROM oauth_grants)
       AND id IN (SELECT id FROM oauth_clients ORDER BY created_at LIMIT ?)`,
    ).run(count - MAX_CLIENTS + 1)
  }

  return {
    getClient,

    registerClient(input: Pick<OAuthClient, 'name' | 'redirectUris' | 'authMethod' | 'grantTypes'>): {
      client: OAuthClient
      secret: string | null
    } {
      pruneClients()
      const secret = input.authMethod === 'none' ? null : secretValue('cdc_')
      const client: OAuthClient = {
        ...input,
        id: randomUUID(),
        createdAt: now(),
        secretHash: secret ? hashToken(secret) : null,
      }
      db.query(
        `INSERT INTO oauth_clients (id, secret_hash, name, redirect_uris, auth_method, grant_types, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        client.id,
        client.secretHash,
        client.name,
        JSON.stringify(client.redirectUris),
        client.authMethod,
        JSON.stringify(client.grantTypes),
        client.createdAt,
      )
      return { client, secret }
    },

    secretMatches(client: OAuthClient, secret: string | null): boolean {
      if (client.secretHash === null) return true
      return secret !== null && passphraseMatches(hashToken(secret), client.secretHash)
    },

    createCode(code: AuthorizationCode): string {
      const value = secretValue('cda_')
      db.query(
        `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scope, resource, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(hashToken(value), code.clientId, code.redirectUri, code.codeChallenge, code.scope, code.resource, now() + CODE_TTL_MS)
      return value
    },

    /** Codes are single use: the row is deleted whether or not the exchange then succeeds. */
    consumeCode(value: string): AuthorizationCode | null {
      const row = db
        .query<
          { client_id: string; redirect_uri: string; code_challenge: string; scope: string; resource: string; expires_at: number },
          [string]
        >('DELETE FROM oauth_codes WHERE code_hash = ? RETURNING *')
        .get(hashToken(value))
      if (!row || row.expires_at <= now()) return null
      return {
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        codeChallenge: row.code_challenge,
        scope: row.scope,
        resource: row.resource,
      }
    },

    createGrant(client: OAuthClient, code: AuthorizationCode): IssuedTokens {
      const grant: Grant = {
        id: randomUUID(),
        clientId: client.id,
        scope: code.scope,
        resource: code.resource,
        createdAt: now(),
        refreshedAt: now(),
        expiresAt: now() + REFRESH_TOKEN_TTL_MS,
      }
      db.query(
        `INSERT INTO oauth_grants (id, client_id, refresh_hash, scope, resource, created_at, refreshed_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(grant.id, grant.clientId, `pending:${grant.id}`, grant.scope, grant.resource, grant.createdAt, grant.refreshedAt, grant.expiresAt)
      return mint(grant, client)
    },

    /**
     * Rotates the refresh token. Presenting the token that was just rotated out means it leaked
     * (or a client raced itself), so the whole grant is revoked.
     */
    refresh(refreshToken: string, client: OAuthClient): RefreshResult {
      const hash = hashToken(refreshToken)
      const current = db
        .query<GrantRow, [string, string]>(`SELECT ${GRANT_COLUMNS} FROM oauth_grants WHERE refresh_hash = ? AND client_id = ?`)
        .get(hash, client.id)
      if (current) {
        const grant = toGrant(current)
        if (grant.expiresAt <= now()) {
          revokeGrant(grant.id)
          return { error: 'invalid' }
        }
        return { tokens: mint(grant, client), grant }
      }
      const replayed = db
        .query<{ id: string }, [string, string]>('SELECT id FROM oauth_grants WHERE previous_refresh_hash = ? AND client_id = ?')
        .get(hash, client.id)
      if (replayed) {
        revokeGrant(replayed.id)
        return { error: 'reused' }
      }
      return { error: 'invalid' }
    },

    /** RFC 7009: revokes the grant behind a refresh token or an access token. */
    revokeToken(value: string, client: OAuthClient): void {
      const byRefresh = db
        .query<{ id: string }, [string, string]>('SELECT id FROM oauth_grants WHERE refresh_hash = ? AND client_id = ?')
        .get(hashToken(value), client.id)
      if (byRefresh) {
        revokeGrant(byRefresh.id)
        return
      }
      const access = tokens.verify(value)
      if (access?.kind === 'oauth' && access.clientId === client.id && access.grantId) revokeGrant(access.grantId)
    },

    getGrant,
    revokeGrant,

    listGrants(): (Grant & { clientName: string; lastUsedAt: number | null })[] {
      pruneClients()
      return db
        .query<GrantRow & { client_name: string | null }, []>(
          `SELECT g.id, g.client_id, g.scope, g.resource, g.created_at, g.refreshed_at, g.expires_at, c.name AS client_name
           FROM oauth_grants g LEFT JOIN oauth_clients c ON c.id = g.client_id ORDER BY g.created_at DESC`,
        )
        .all()
        .map((row) => ({
          ...toGrant(row),
          clientName: row.client_name ?? 'Removed client',
          lastUsedAt: tokens.grantLastUsed(row.id),
        }))
    },
  }
}

export type OAuthStore = ReturnType<typeof createOAuthStore>
