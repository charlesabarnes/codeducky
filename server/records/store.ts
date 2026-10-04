import type { Database } from 'bun:sqlite'
import {
  pairId,
  SYNC_PAGE_SIZE,
  validateChange,
  wins,
  type RecordData,
  type RejectedChange,
  type ServerChange,
  type SyncKind,
  type SyncResponse,
  type WireChange,
} from '../../shared/sync'
import type { ChecklistRecord, DataSnapshot, InboxRecord, NoteRecord, RepoRecord, SessionRecord } from '../mcp/records'
import { checkQuota, hasRoomFor } from './quota'

/**
 * The only module that reads or writes the records table. Every function takes the user whose
 * records it touches; one user's records, revs and cursor never show up for another.
 */

interface Row {
  kind: SyncKind
  id: string
  changed_at: number
  deleted: number
  rev: number
  data: string | null
}

const ROW_COLUMNS = 'kind, id, changed_at, deleted, rev, data'

function toChange(row: Row): ServerChange {
  const change: ServerChange = {
    kind: row.kind,
    id: row.id,
    changedAt: row.changed_at,
    deleted: row.deleted === 1,
    rev: row.rev,
  }
  if (row.deleted === 0 && row.data !== null) change.data = JSON.parse(row.data) as RecordData
  return change
}

/** Takes the user's next rev and applies the change to their usage counters in one write. */
function nextRev(db: Database, userId: string, rows: number, bytes: number): number {
  const row = db
    .query<{ rev: number }, [number, number, string]>(
      'UPDATE users SET rev = rev + 1, record_count = record_count + ?, data_bytes = data_bytes + ? WHERE id = ? RETURNING rev',
    )
    .get(rows, bytes, userId)
  if (!row) throw new Error('unknown user')
  return row.rev
}

function current(db: Database, userId: string, kind: SyncKind, id: string) {
  return db
    .query<{ changed_at: number; deleted: number; bytes: number }, [string, string, string]>(
      `SELECT changed_at, deleted, coalesce(length(CAST(data AS BLOB)), 0) AS bytes FROM records
       WHERE user_id = ? AND kind = ? AND id = ?`,
    )
    .get(userId, kind, id)
}

/**
 * Stores the change if it wins against the stored version; returns whether it was applied. A live write
 * that grows the user's usage past their quota throws QuotaError. Deleting a stored record always
 * applies; a tombstone for an id never stored is dropped once the user is at their row limit.
 */
export function applyChange(db: Database, userId: string, change: WireChange): boolean {
  const existing = current(db, userId, change.kind, change.id)
  if (existing && !wins(change, { changedAt: existing.changed_at, deleted: existing.deleted === 1 })) return false
  if (change.deleted && !existing && !hasRoomFor(db, userId, 1)) return false
  const data = change.deleted ? null : JSON.stringify(change.data ?? {})
  const bytes = (data === null ? 0 : Buffer.byteLength(data)) - (existing?.bytes ?? 0)
  if (!change.deleted) checkQuota(db, userId, existing ? 0 : 1, bytes)
  db.query(
    `INSERT INTO records (user_id, kind, id, changed_at, deleted, rev, data) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, kind, id) DO UPDATE SET changed_at = excluded.changed_at, deleted = excluded.deleted,
       rev = excluded.rev, data = excluded.data`,
  ).run(userId, change.kind, change.id, change.changedAt, change.deleted ? 1 : 0, nextRev(db, userId, existing ? 0 : 1, bytes), data)
  return true
}

/** A write made by the server itself (MCP tools); it always wins over what is stored. */
export function writeRecord(
  db: Database,
  userId: string,
  kind: SyncKind,
  id: string,
  data: RecordData | null,
  now = Date.now(),
): ServerChange {
  return db.transaction(() => {
    const existing = current(db, userId, kind, id)
    const changedAt = Math.max(now, (existing?.changed_at ?? 0) + 1)
    applyChange(db, userId, data ? { kind, id, changedAt, deleted: false, data } : { kind, id, changedAt, deleted: true })
    return readRecord(db, userId, kind, id)!
  })()
}

export function readRecord(db: Database, userId: string, kind: SyncKind, id: string): ServerChange | null {
  const row = db
    .query<Row, [string, string, string]>(`SELECT ${ROW_COLUMNS} FROM records WHERE user_id = ? AND kind = ? AND id = ?`)
    .get(userId, kind, id)
  return row ? toChange(row) : null
}

/** Applies a pushed batch, record by record, then returns one page of the user's change feed after `cursor`. */
export function sync(db: Database, userId: string, cursor: number, incoming: WireChange[], invalid: RejectedChange[] = []): SyncResponse {
  const applyOne = db.transaction((change: WireChange) => applyChange(db, userId, change))
  return db.transaction(() => {
    const rejected = [...invalid]
    for (const change of incoming) {
      try {
        applyOne(change)
      } catch (err) {
        rejected.push({ kind: change.kind, id: change.id, error: err instanceof Error ? err.message : 'could not apply' })
      }
    }
    const rows = db
      .query<Row, [string, number, number]>(`SELECT ${ROW_COLUMNS} FROM records WHERE user_id = ? AND rev > ? ORDER BY rev LIMIT ?`)
      .all(userId, cursor, SYNC_PAGE_SIZE + 1)
    const page = rows.slice(0, SYNC_PAGE_SIZE)
    return {
      changes: page.map(toChange),
      newCursor: page.at(-1)?.rev ?? cursor,
      more: rows.length > SYNC_PAGE_SIZE,
      rejected,
    }
  })()
}

export function listRecords<T>(db: Database, userId: string, kind: SyncKind): T[] {
  return db
    .query<{ id: string; data: string }, [string, string]>('SELECT id, data FROM records WHERE user_id = ? AND kind = ? AND deleted = 0')
    .all(userId, kind)
    .map((row) => ({ ...(JSON.parse(row.data) as object), id: row.id }) as T)
}

export function getRecord<T>(db: Database, userId: string, kind: SyncKind, id: string): T | null {
  const row = db
    .query<{ data: string }, [string, string, string]>(
      'SELECT data FROM records WHERE user_id = ? AND kind = ? AND id = ? AND deleted = 0',
    )
    .get(userId, kind, id)
  return row ? ({ ...(JSON.parse(row.data) as object), id } as T) : null
}

export class InvalidRecordError extends Error {}

/** Validates like a pushed change, then writes through `writeRecord`, so the PWA picks it up on its next sync. */
export function saveRecord(db: Database, userId: string, kind: SyncKind, id: string, record: object, now = Date.now()): void {
  const data: RecordData = {}
  for (const [field, value] of Object.entries(record)) if (field !== 'id' && value !== undefined) data[field] = value
  const error = validateChange({ kind, id, changedAt: now, deleted: false, data })
  if (error) throw new InvalidRecordError(error)
  writeRecord(db, userId, kind, id, data, now)
}

/** Read-only snapshot of one user's records, loaded once per request. */
export function loadData(db: Database, userId: string): DataSnapshot {
  const repos = listRecords<RepoRecord>(db, userId, 'repos')
  const sessions = listRecords<SessionRecord>(db, userId, 'sessions')
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  return {
    repos,
    sessions,
    repoById,
    notes: () => listRecords<NoteRecord>(db, userId, 'notes'),
    checklists: () => listRecords<ChecklistRecord>(db, userId, 'checklists'),
    inbox: () => getRecord<InboxRecord>(db, userId, 'inbox', 'inbox'),
    checked: (sessionId: string, itemId: string) =>
      getRecord<{ checked: boolean }>(db, userId, 'checklistState', pairId(sessionId, itemId))?.checked ?? false,
  }
}
