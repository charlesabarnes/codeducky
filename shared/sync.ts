/** Wire protocol for `POST /api/sync`, shared by the PWA and the server. */

export const SYNC_KINDS = ['repos', 'sessions', 'notes', 'checklists', 'checklistState', 'fileViews'] as const
export type SyncKind = (typeof SYNC_KINDS)[number]

export type RecordData = Record<string, unknown>

/** One record version. Tombstones carry no data. */
export interface WireChange {
  kind: SyncKind
  id: string
  changedAt: number
  deleted: boolean
  data?: RecordData
}

/** A change as the server stored it; `rev` orders the change feed. */
export interface ServerChange extends WireChange {
  rev: number
}

export interface SyncRequest {
  cursor: number
  changes: WireChange[]
}

/** A pushed change the server refused; the rest of the batch is still applied. */
export interface RejectedChange {
  kind: string
  id: string
  error: string
}

export interface SyncResponse {
  changes: ServerChange[]
  newCursor: number
  more: boolean
  rejected: RejectedChange[]
}

export const SYNC_PAGE_SIZE = 500
export const MAX_PUSH = 500
export const MAX_RECORD_BYTES = 256 * 1024

export interface Version {
  changedAt: number
  deleted: boolean
}

/** Last write wins; on a tie a delete beats an edit, otherwise the current version stays. */
export function wins(incoming: Version, current: Version | null | undefined): boolean {
  if (!current) return true
  if (incoming.changedAt !== current.changedAt) return incoming.changedAt > current.changedAt
  return incoming.deleted && !current.deleted
}

/** Sync id of a record keyed by [sessionId, path] or [sessionId, itemId]. */
export const pairId = (sessionId: string, second: string) => JSON.stringify([sessionId, second])

export function parsePairId(id: string): [string, string] | null {
  try {
    const value: unknown = JSON.parse(id)
    if (Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === 'string')) {
      return [value[0] as string, value[1] as string]
    }
  } catch {
    // not a pair id
  }
  return null
}

export function isSyncKind(kind: unknown): kind is SyncKind {
  return typeof kind === 'string' && (SYNC_KINDS as readonly string[]).includes(kind)
}

type Check = (value: unknown) => boolean

const str: Check = (v) => typeof v === 'string'
const num: Check = (v) => typeof v === 'number' && Number.isFinite(v)
const bool: Check = (v) => typeof v === 'boolean'
const oneOf =
  (...values: string[]): Check =>
  (v) =>
    typeof v === 'string' && values.includes(v)
const optional =
  (check: Check): Check =>
  (v) =>
    v === undefined || v === null || check(v)
const arrayOf =
  (check: Check): Check =>
  (v) =>
    Array.isArray(v) && v.every(check)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const shape =
  (fields: Record<string, Check>): Check =>
  (v) =>
    isObject(v) && Object.entries(fields).every(([key, check]) => check(v[key]))

const anchor = shape({ line: num, side: oneOf('old', 'new'), text: str, before: arrayOf(str), after: arrayOf(str) })

/** 'claude' only appears on notes from the removed in-app Claude pass. */
export const NOTE_SOURCES = ['me', 'claude', 'mcp'] as const

const FIELDS: Record<SyncKind, Record<string, Check>> = {
  repos: { owner: str, name: str, folderName: str, baseBranch: str, lastOpenedAt: num, instructions: optional(str) },
  sessions: {
    repoId: str,
    branch: str,
    headSha: str,
    baseSha: str,
    baseSource: oneOf('local', 'github'),
    startedAt: num,
    status: oneOf('active', 'archived'),
    files: optional(arrayOf(shape({ path: str, status: str }))),
  },
  notes: {
    sessionId: str,
    path: str,
    anchor,
    body: str,
    severity: oneOf('nit', 'suggestion', 'issue', 'blocker'),
    status: oneOf('open', 'resolved', 'suggested', 'dismissed'),
    source: oneOf(...NOTE_SOURCES),
    createdAt: num,
    updatedAt: num,
    resolution: optional(shape({ by: str, text: str, at: num })),
  },
  checklists: { scope: str, title: str, items: arrayOf(shape({ id: str, text: str })), required: optional(bool) },
  checklistState: { sessionId: str, itemId: str, checked: bool },
  fileViews: { sessionId: str, path: str, contentHash: str, viewed: bool },
}

function pairMatches(kind: SyncKind, id: string, data: RecordData): boolean {
  if (kind === 'checklistState') return id === pairId(data.sessionId as string, data.itemId as string)
  if (kind === 'fileViews') return id === pairId(data.sessionId as string, data.path as string)
  return true
}

/** Returns an error message, or null when the change is well-formed. Tombstones only need the envelope. */
export function validateChange(change: unknown): string | null {
  if (!isObject(change)) return 'change must be an object'
  const { kind, id, changedAt, deleted, data } = change
  if (!isSyncKind(kind)) return `unknown kind: ${String(kind)}`
  if (typeof id !== 'string' || id === '' || id.length > 1024) return 'id must be a non-empty string'
  if (!num(changedAt)) return 'changedAt must be a number'
  if (!bool(deleted)) return 'deleted must be a boolean'
  if (deleted) return null
  if (!isObject(data)) return 'data must be an object'
  for (const [field, check] of Object.entries(FIELDS[kind])) {
    if (!check(data[field])) return `${kind}.${field} is invalid`
  }
  if (!pairMatches(kind, id, data)) return `${kind} id does not match its key fields`
  if (JSON.stringify(data).length > MAX_RECORD_BYTES) return 'record is too large'
  return null
}

function describe(change: unknown): Omit<RejectedChange, 'error'> {
  const kind = isObject(change) ? change.kind : undefined
  const id = isObject(change) ? change.id : undefined
  return { kind: typeof kind === 'string' ? kind : '', id: typeof id === 'string' ? id : '' }
}

export type ParsedSyncRequest = { cursor: number; changes: WireChange[]; rejected: RejectedChange[] } | { error: string }

/** Rejects only a malformed envelope; invalid changes are split out so the valid ones still apply. */
export function parseSyncRequest(body: unknown): ParsedSyncRequest {
  if (!isObject(body)) return { error: 'body must be an object' }
  const { cursor, changes } = body
  if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0) {
    return { error: 'cursor must be a non-negative integer' }
  }
  if (!Array.isArray(changes)) return { error: 'changes must be an array' }
  if (changes.length > MAX_PUSH) return { error: `at most ${MAX_PUSH} changes per request` }
  const valid: WireChange[] = []
  const rejected: RejectedChange[] = []
  for (const change of changes as unknown[]) {
    const error = validateChange(change)
    if (error) rejected.push({ ...describe(change), error })
    else {
      const { kind, id, changedAt, deleted, data } = change as WireChange
      valid.push(deleted ? { kind, id, changedAt, deleted } : { kind, id, changedAt, deleted, data })
    }
  }
  return { cursor, changes: valid, rejected }
}
