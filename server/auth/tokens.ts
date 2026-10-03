import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { hashToken, newToken } from './passphrase'

/**
 * Every bearer credential lives in one table: PWA sign-ins (`session`), named tokens minted in
 * Settings (`api`), and later OAuth access tokens (`oauth`). Only hashes are stored, and every
 * request is checked through `verify`, whatever issued the token.
 */
export type TokenKind = 'session' | 'api' | 'oauth'

export interface TokenInfo {
  id: string
  name: string
  kind: TokenKind
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  clientId: string | null
  scope: string | null
}

export interface IssueOptions {
  name: string
  kind: TokenKind
  expiresAt?: number | null
  clientId?: string | null
  scope?: string | null
}

interface Row {
  id: string
  name: string
  kind: TokenKind
  created_at: number
  last_used_at: number | null
  expires_at: number | null
  client_id: string | null
  scope: string | null
}

const COLUMNS = 'id, name, kind, created_at, last_used_at, expires_at, client_id, scope'
/** last_used_at is only rewritten when it is older than this, to avoid a write per request. */
const TOUCH_AFTER_MS = 60_000

const toInfo = (row: Row): TokenInfo => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  expiresAt: row.expires_at,
  clientId: row.client_id,
  scope: row.scope,
})

export function createTokenStore(db: Database, now: () => number = Date.now) {
  return {
    /** Returns the raw token once; only its hash is kept. */
    issue(options: IssueOptions): { token: string; info: TokenInfo } {
      const token = newToken()
      const row: Row = {
        id: randomUUID(),
        name: options.name,
        kind: options.kind,
        created_at: now(),
        last_used_at: null,
        expires_at: options.expiresAt ?? null,
        client_id: options.clientId ?? null,
        scope: options.scope ?? null,
      }
      db.query(
        `INSERT INTO tokens (token_hash, ${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(hashToken(token), row.id, row.name, row.kind, row.created_at, null, row.expires_at, row.client_id, row.scope)
      return { token, info: toInfo(row) }
    },

    /** The single validation path for every bearer token. */
    verify(token: string): TokenInfo | null {
      const row = db.query<Row, [string]>(`SELECT ${COLUMNS} FROM tokens WHERE token_hash = ?`).get(hashToken(token))
      if (!row) return null
      if (row.expires_at !== null && row.expires_at <= now()) {
        db.query('DELETE FROM tokens WHERE id = ?').run(row.id)
        return null
      }
      if (row.last_used_at === null || now() - row.last_used_at > TOUCH_AFTER_MS) {
        row.last_used_at = now()
        db.query('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(row.last_used_at, row.id)
      }
      return toInfo(row)
    },

    list(): TokenInfo[] {
      db.query('DELETE FROM tokens WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now())
      return db.query<Row, []>(`SELECT ${COLUMNS} FROM tokens ORDER BY created_at DESC`).all().map(toInfo)
    },

    revoke(id: string): boolean {
      return db.query('DELETE FROM tokens WHERE id = ?').run(id).changes > 0
    },
  }
}

export type TokenStore = ReturnType<typeof createTokenStore>
