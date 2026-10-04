import type { Database } from 'bun:sqlite'
import { defaultQuotas, type Quotas } from '../records/quota'
import type { UserRole, UserStatus } from '../users/store'

/** A user's own limits; null means the configured default applies. */
export interface QuotaOverride {
  records: number | null
  bytes: number | null
}

/** What the admin sees of an account: profile, status and usage, never record contents. */
export interface AccountSummary {
  id: string
  login: string
  name: string | null
  avatarUrl: string | null
  role: UserRole
  status: UserStatus
  createdAt: number
  lastLoginAt: number | null
  lastSeenAt: number | null
  usage: Quotas
  /** The limits in force: the override where set, otherwise the default. */
  quota: Quotas
  override: QuotaOverride
}

export interface Stats {
  /** GitHub accounts; the admin is not counted. */
  users: number
  disabled: number
  signupsLastDay: number
  dbBytes: number
}

interface Row {
  id: string
  login: string
  name: string | null
  avatar_url: string | null
  role: UserRole
  status: UserStatus
  created_at: number
  last_login_at: number | null
  last_seen_at: number | null
  record_count: number
  data_bytes: number
  quota_records: number | null
  quota_bytes: number | null
}

const DAY_MS = 24 * 60 * 60_000

export function listAccounts(db: Database): AccountSummary[] {
  const fallback = defaultQuotas(db)
  return db
    .query<Row, []>(
      `SELECT id, login, name, avatar_url, role, status, created_at, last_login_at, last_seen_at,
         record_count, data_bytes, quota_records, quota_bytes
       FROM users ORDER BY role = 'admin' DESC, created_at, login, id`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      login: row.login,
      name: row.name,
      avatarUrl: row.avatar_url,
      role: row.role,
      status: row.status,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
      lastSeenAt: row.last_seen_at,
      usage: { records: row.record_count, bytes: row.data_bytes },
      quota: { records: row.quota_records ?? fallback.records, bytes: row.quota_bytes ?? fallback.bytes },
      override: { records: row.quota_records, bytes: row.quota_bytes },
    }))
}

export function stats(db: Database, now: number): Stats {
  const counts = db
    .query<{ users: number; disabled: number; recent: number }, [number]>(
      `SELECT COUNT(*) AS users, COUNT(*) FILTER (WHERE status = 'disabled') AS disabled,
         COUNT(*) FILTER (WHERE created_at > ?) AS recent
       FROM users WHERE role = 'user'`,
    )
    .get(now - DAY_MS)!
  const pages = db.query<{ page_count: number }, []>('PRAGMA page_count').get()!.page_count
  const pageSize = db.query<{ page_size: number }, []>('PRAGMA page_size').get()!.page_size
  return { users: counts.users, disabled: counts.disabled, signupsLastDay: counts.recent, dbBytes: pages * pageSize }
}

export function setStatus(db: Database, id: string, status: UserStatus): boolean {
  return db.query('UPDATE users SET status = ? WHERE id = ?').run(status, id).changes > 0
}

/** Sets the given limits; a key left out keeps its current value, and null returns it to the default. */
export function setQuotaOverride(db: Database, id: string, override: Partial<QuotaOverride>): boolean {
  const current = db
    .query<{ quota_records: number | null; quota_bytes: number | null }, [string]>('SELECT quota_records, quota_bytes FROM users WHERE id = ?')
    .get(id)
  if (!current) return false
  db.query('UPDATE users SET quota_records = ?, quota_bytes = ? WHERE id = ?').run(
    override.records !== undefined ? override.records : current.quota_records,
    override.bytes !== undefined ? override.bytes : current.quota_bytes,
    id,
  )
  return true
}

/** Drops GitHub round-trips and PWA hand-offs the user has in progress, so none can complete. */
export function forgetPendingSignIns(db: Database, userId: string): void {
  db.query('DELETE FROM auth_flows WHERE user_id = ?').run(userId)
  db.query('DELETE FROM auth_handoffs WHERE user_id = ?').run(userId)
}
