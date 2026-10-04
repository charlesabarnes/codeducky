import type { Database } from 'bun:sqlite'
import { positiveInt } from '../limits'

/** Per-user storage limits: rows (live and tombstones) and UTF-8 bytes of live data. */
export interface Quotas {
  records: number
  bytes: number
}

export const DEFAULT_QUOTAS: Quotas = { records: 20_000, bytes: 50 * 1024 * 1024 }

export function loadQuotas(env: Record<string, string | undefined>): Quotas {
  return {
    records: positiveInt(env, 'CODEDUCKY_QUOTA_RECORDS') ?? DEFAULT_QUOTAS.records,
    bytes: positiveInt(env, 'CODEDUCKY_QUOTA_BYTES') ?? DEFAULT_QUOTAS.bytes,
  }
}

/** The configured defaults, per database, so every write path sees them without threading them through. */
const defaults = new WeakMap<Database, Quotas>()

export function setDefaultQuotas(db: Database, quotas: Quotas): void {
  defaults.set(db, quotas)
}

/** The message is the wire error code; `detail` is the explanation shown to MCP clients. */
export class QuotaError extends Error {
  readonly limit: keyof Quotas

  constructor(limit: keyof Quotas) {
    super('quota_exceeded')
    this.limit = limit
  }

  get detail(): string {
    return this.limit === 'records'
      ? 'Quota exceeded: this account has reached its record limit. Ask the Code Ducky admin to raise it.'
      : 'Quota exceeded: this account has reached its storage limit. Delete notes, sessions or repos in Code Ducky to make room.'
  }
}

export interface Usage {
  usage: Quotas
  quota: Quotas
}

/** The user's usage and their quota: their own override where set, otherwise the configured default. */
export function getUsage(db: Database, userId: string): Usage {
  const fallback = defaults.get(db) ?? DEFAULT_QUOTAS
  const row = db
    .query<{ record_count: number; data_bytes: number; quota_records: number; quota_bytes: number }, [number, number, string]>(
      `SELECT record_count, data_bytes, coalesce(quota_records, ?) AS quota_records, coalesce(quota_bytes, ?) AS quota_bytes
       FROM users WHERE id = ?`,
    )
    .get(fallback.records, fallback.bytes, userId)
  if (!row) throw new Error('unknown user')
  return {
    usage: { records: row.record_count, bytes: row.data_bytes },
    quota: { records: row.quota_records, bytes: row.quota_bytes },
  }
}

/** Throws QuotaError if a write that grows usage would take the user past a limit; shrinking always passes. */
export function checkQuota(db: Database, userId: string, rows: number, bytes: number): void {
  if (rows <= 0 && bytes <= 0) return
  const { usage, quota } = getUsage(db, userId)
  if (rows > 0 && usage.records + rows > quota.records) throw new QuotaError('records')
  if (bytes > 0 && usage.bytes + bytes > quota.bytes) throw new QuotaError('bytes')
}
