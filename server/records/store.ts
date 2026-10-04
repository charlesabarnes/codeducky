import type { Database } from 'bun:sqlite'
import {
  SYNC_PAGE_SIZE,
  wins,
  type RecordData,
  type RejectedChange,
  type ServerChange,
  type SyncKind,
  type SyncResponse,
  type WireChange,
} from '../shared/sync'

interface Row {
  kind: SyncKind
  id: string
  changed_at: number
  deleted: number
  rev: number
  data: string | null
}

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

function nextRev(db: Database): number {
  return db.query<{ value: number }, []>("UPDATE meta SET value = value + 1 WHERE key = 'rev' RETURNING value").get()!.value
}

function current(db: Database, kind: SyncKind, id: string) {
  return db
    .query<{ changed_at: number; deleted: number }, [string, string]>(
      'SELECT changed_at, deleted FROM records WHERE kind = ? AND id = ?',
    )
    .get(kind, id)
}

/** Stores the change if it wins against the stored version; returns whether it was applied. */
export function applyChange(db: Database, change: WireChange): boolean {
  const existing = current(db, change.kind, change.id)
  if (existing && !wins(change, { changedAt: existing.changed_at, deleted: existing.deleted === 1 })) return false
  db.query(
    `INSERT INTO records (kind, id, changed_at, deleted, rev, data) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (kind, id) DO UPDATE SET changed_at = excluded.changed_at, deleted = excluded.deleted,
       rev = excluded.rev, data = excluded.data`,
  ).run(
    change.kind,
    change.id,
    change.changedAt,
    change.deleted ? 1 : 0,
    nextRev(db),
    change.deleted ? null : JSON.stringify(change.data ?? {}),
  )
  return true
}

/** A write made by the server itself (later: MCP tools); it always wins over what is stored. */
export function writeRecord(db: Database, kind: SyncKind, id: string, data: RecordData | null, now = Date.now()): ServerChange {
  return db.transaction(() => {
    const existing = current(db, kind, id)
    const changedAt = Math.max(now, (existing?.changed_at ?? 0) + 1)
    applyChange(db, data ? { kind, id, changedAt, deleted: false, data } : { kind, id, changedAt, deleted: true })
    return readRecord(db, kind, id)!
  })()
}

export function readRecord(db: Database, kind: SyncKind, id: string): ServerChange | null {
  const row = db.query<Row, [string, string]>('SELECT * FROM records WHERE kind = ? AND id = ?').get(kind, id)
  return row ? toChange(row) : null
}

/** Applies a pushed batch, record by record, then returns one page of the change feed after `cursor`. */
export function sync(db: Database, cursor: number, incoming: WireChange[], invalid: RejectedChange[] = []): SyncResponse {
  const applyOne = db.transaction((change: WireChange) => applyChange(db, change))
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
      .query<Row, [number, number]>('SELECT * FROM records WHERE rev > ? ORDER BY rev LIMIT ?')
      .all(cursor, SYNC_PAGE_SIZE + 1)
    const page = rows.slice(0, SYNC_PAGE_SIZE)
    return {
      changes: page.map(toChange),
      newCursor: page.at(-1)?.rev ?? cursor,
      more: rows.length > SYNC_PAGE_SIZE,
      rejected,
    }
  })()
}
