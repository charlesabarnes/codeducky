import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

/** The built-in account the admin passphrase signs in to. */
export const ADMIN_USER_ID = 'admin'

export type UserRole = 'user' | 'admin'
export type UserStatus = 'active' | 'disabled'

export interface User {
  id: string
  githubId: number | null
  login: string
  name: string | null
  avatarUrl: string | null
  role: UserRole
  status: UserStatus
  createdAt: number
  lastLoginAt: number | null
  lastSeenAt: number | null
}

/** Who GitHub says signed in; `id` is the stable key, the rest is refreshed on every sign-in. */
export interface GitHubIdentity {
  id: number
  login: string
  name: string | null
  avatarUrl: string | null
}

interface Row {
  id: string
  github_id: number | null
  login: string
  name: string | null
  avatar_url: string | null
  role: UserRole
  status: UserStatus
  created_at: number
  last_login_at: number | null
  last_seen_at: number | null
}

const COLUMNS = 'id, github_id, login, name, avatar_url, role, status, created_at, last_login_at, last_seen_at'

const toUser = (row: Row): User => ({
  id: row.id,
  githubId: row.github_id,
  login: row.login,
  name: row.name,
  avatarUrl: row.avatar_url,
  role: row.role,
  status: row.status,
  createdAt: row.created_at,
  lastLoginAt: row.last_login_at,
  lastSeenAt: row.last_seen_at,
})

export function getUser(db: Database, id: string): User | null {
  const row = db.query<Row, [string]>(`SELECT ${COLUMNS} FROM users WHERE id = ?`).get(id)
  return row ? toUser(row) : null
}

export function getUserByGitHubId(db: Database, githubId: number): User | null {
  const row = db.query<Row, [number]>(`SELECT ${COLUMNS} FROM users WHERE github_id = ?`).get(githubId)
  return row ? toUser(row) : null
}

/** Creates the user on first sign-in, or refreshes their profile; either way records the login time. */
export function upsertGitHubUser(db: Database, identity: GitHubIdentity, now = Date.now()): User {
  const row = db
    .query<Row, [string, number, string, string | null, string | null, number, number]>(
      `INSERT INTO users (id, github_id, login, name, avatar_url, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (github_id) DO UPDATE SET login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url,
         last_login_at = excluded.last_login_at
       RETURNING ${COLUMNS}`,
    )
    .get(randomUUID(), identity.id, identity.login, identity.name, identity.avatarUrl, now, now)!
  return toUser(row)
}

/** Inserts the built-in admin account if it is missing. */
export function ensureAdmin(db: Database, now = Date.now()): void {
  db.query(`INSERT INTO users (id, login, role, created_at) VALUES (?, 'admin', 'admin', ?) ON CONFLICT (id) DO NOTHING`).run(
    ADMIN_USER_ID,
    now,
  )
}
