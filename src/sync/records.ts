import { pairId, parsePairId, type RecordData, type SyncKind, type WireChange } from '../../shared/sync'

type Key = string | [string, string]
type Row = Record<string, unknown>

/** How one synced Dexie table maps to wire records. */
interface RecordSpec {
  /** The sync id of a stored row. */
  idOf(row: Row): string
  /** The sync id of a primary key. */
  idOfKey(key: unknown): string
  /** The primary key for a sync id, or null if the id is malformed. */
  keyOf(id: string): Key | null
  /** Fields that never leave the device. */
  local: readonly string[]
}

const byId: RecordSpec = {
  idOf: (row) => row.id as string,
  idOfKey: (key) => key as string,
  keyOf: (id) => id,
  local: ['id', 'changedAt'],
}

const byPair = (second: string): RecordSpec => ({
  idOf: (row) => pairId(row.sessionId as string, row[second] as string),
  idOfKey: (key) => {
    const [sessionId, other] = key as [string, string]
    return pairId(sessionId, other)
  },
  keyOf: (id) => parsePairId(id),
  local: ['changedAt'],
})

export const RECORD_SPECS: Record<SyncKind, RecordSpec> = {
  repos: { ...byId, local: ['id', 'changedAt', 'dirHandle'] },
  sessions: byId,
  notes: byId,
  checklists: byId,
  checklistState: byPair('itemId'),
  fileViews: byPair('path'),
}

/** Synced tables share their name with their sync kind. */
export const isSyncedTable = (name: string): name is SyncKind => Object.hasOwn(RECORD_SPECS, name)

export const HAS_GENERATED_ID: ReadonlySet<SyncKind> = new Set(['repos', 'sessions', 'notes', 'checklists'])

export function toWire(kind: SyncKind, row: Row): WireChange {
  const spec = RECORD_SPECS[kind]
  const data: RecordData = {}
  for (const [field, value] of Object.entries(row)) {
    if (!spec.local.includes(field) && value !== undefined) data[field] = value
  }
  return { kind, id: spec.idOf(row), changedAt: (row.changedAt as number | undefined) ?? 0, deleted: false, data }
}

/** The Dexie row for a wire record; keyed fields come from the data, ids from the envelope. */
export function fromWire(change: WireChange): Row {
  const row: Row = { ...change.data, changedAt: change.changedAt }
  if (HAS_GENERATED_ID.has(change.kind)) row.id = change.id
  return row
}
