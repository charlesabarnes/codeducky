import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import type { UserRole, UserStatus } from '../users/store'
import { hashToken, newToken } from './passphrase'

/**
 * Every bearer credential lives in one table: PWA sign-ins (`session`), named tokens minted in
 * Settings (`api`), and OAuth access tokens (`oauth`, see oauth/store.ts). Only hashes are stored, and every
 * request is checked through `verify`, whatever issued the token.
 */
export type TokenKind = 'session' | 'api' | 'oauth'

export interface TokenInfo {
  id: string
  /** The user the token acts for; every data access is scoped to them. */
  userId: string
  user: { id: string; login: string; role: UserRole }
  name: string
  kind: TokenKind
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  clientId: string | null
  scope: string | null
  /** The OAuth grant an access token belongs to; revoking the grant revokes its tokens. */
  grantId: string | null
}

export interface IssueOptions {
  userId: string
  name: string
  kind: TokenKind
  expiresAt?: number | null
  clientId?: string | null
  scope?: string | null
  grantId?: string | null
}

interface Row {
  id: string
  user_id: string
  user_login: string
  user_role: UserRole
  user_status: UserStatus
  user_last_seen_at: number | null
  name: string
  kind: TokenKind
  created_at: number
  last_used_at: number | null
  expires_at: number | null
  client_id: string | null
  scope: string | null
  grant_id: string | null
}

const COLUMNS = 'id, user_id, name, kind, created_at, last_used_at, expires_at, client_id, scope, grant_id'
const SELECT = `SELECT t.id, t.user_id, t.name, t.kind, t.created_at, t.last_used_at, t.expires_at, t.client_id, t.scope, t.grant_id,
  u.login AS user_login, u.role AS user_role, u.status AS user_status, u.last_seen_at AS user_last_seen_at
  FROM tokens t JOIN users u ON u.id = t.user_id`
/** last_used_at and last_seen_at are only rewritten when older than this, to avoid a write per request. */
const TOUCH_AFTER_MS = 60_000
/** Device sessions kept per user; signing in on another device evicts the oldest. */
export const MAX_SESSIONS = 20
/** Named API tokens a user may hold. */
export const MAX_API_TOKENS = 20

const toInfo = (row: Row): TokenInfo => ({
  id: row.id,
  userId: row.user_id,
  user: { id: row.user_id, login: row.user_login, role: row.user_role },
  name: row.name,
  kind: row.kind,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  expiresAt: row.expires_at,
  clientId: row.client_id,
  scope: row.scope,
  grantId: row.grant_id,
})

export function createTokenStore(db: Database, now: () => number = Date.now) {
  return {
    /** Returns the raw token once; only its hash is kept. */
    issue(options: IssueOptions): { token: string; info: TokenInfo } {
      const token = newToken()
      const id = randomUUID()
      db.query(`INSERT INTO tokens (token_hash, ${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        hashToken(token),
        id,
        options.userId,
        options.name,
        options.kind,
        now(),
        null,
        options.expiresAt ?? null,
        options.clientId ?? null,
        options.scope ?? null,
        options.grantId ?? null,
      )
      if (options.kind === 'session') {
        db.query(
          `DELETE FROM tokens WHERE id IN (
             SELECT id FROM tokens WHERE user_id = ? AND kind = 'session' ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)`,
        ).run(options.userId, MAX_SESSIONS)
      }
      return { token, info: toInfo(db.query<Row, [string]>(`${SELECT} WHERE t.id = ?`).get(id)!) }
    },

    /** The single validation path for every bearer token. */
    verify(token: string): TokenInfo | null {
      const row = db.query<Row, [string]>(`${SELECT} WHERE t.token_hash = ?`).get(hashToken(token))
      if (!row || row.user_status !== 'active') return null
      if (row.expires_at !== null && row.expires_at <= now()) {
        db.query('DELETE FROM tokens WHERE id = ?').run(row.id)
        return null
      }
      if (row.last_used_at === null || now() - row.last_used_at > TOUCH_AFTER_MS) {
        row.last_used_at = now()
        db.query('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(row.last_used_at, row.id)
      }
      if (row.user_last_seen_at === null || now() - row.user_last_seen_at > TOUCH_AFTER_MS) {
        db.query('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), row.user_id)
      }
      return toInfo(row)
    },

    list(userId: string): TokenInfo[] {
      db.query('DELETE FROM tokens WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now())
      return db.query<Row, [string]>(`${SELECT} WHERE t.user_id = ? ORDER BY t.created_at DESC`).all(userId).map(toInfo)
    },

    /** Only the user's own tokens; another user's id is treated as unknown. */
    revoke(userId: string, id: string): boolean {
      return db.query('DELETE FROM tokens WHERE id = ? AND user_id = ?').run(id, userId).changes > 0
    },

    /** Signs the user out everywhere: sessions, API tokens and OAuth access tokens. */
    revokeAllForUser(userId: string): number {
      return db.query('DELETE FROM tokens WHERE user_id = ?').run(userId).changes
    },

    countByKind(userId: string, kind: TokenKind): number {
      return db
        .query<{ n: number }, [string, TokenKind, number]>(
          'SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND kind = ? AND (expires_at IS NULL OR expires_at > ?)',
        )
        .get(userId, kind, now())!.n
    },

    /** Internal: callers check that the grant belongs to the user first. */
    revokeGrant(grantId: string): number {
      return db.query('DELETE FROM tokens WHERE grant_id = ?').run(grantId).changes
    },

    /** The most recent use of any access token issued under a grant. */
    grantLastUsed(grantId: string): number | null {
      return (
        db.query<{ at: number | null }, [string]>('SELECT MAX(last_used_at) AS at FROM tokens WHERE grant_id = ?').get(grantId)?.at ??
        null
      )
    },
  }
}

export type TokenStore = ReturnType<typeof createTokenStore>
