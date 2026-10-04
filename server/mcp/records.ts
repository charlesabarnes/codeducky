import type { Database } from 'bun:sqlite'
import { pairId, validateChange, type RecordData, type SyncKind } from '../../shared/sync'
import { writeRecord } from '../sync'

/** Server-side views of the synced records (see src/db/schema.ts for the PWA's types). */
export interface RepoRecord {
  id: string
  owner: string
  name: string
  folderName: string
  baseBranch: string
  lastOpenedAt: number
  instructions?: string
  /** Legacy name of `instructions`; read through `repoInstructions` from shared/instructions. */
  claudeInstructions?: string
}

export interface SessionRecord {
  id: string
  repoId: string
  branch: string
  headSha: string
  baseSha: string
  startedAt: number
  status: 'active' | 'archived'
  /** The changed files as the PWA's last scan saw them. */
  files?: { path: string; status: string; additions?: number; deletions?: number; binary?: boolean }[]
  /** 'github-pr' for pull request reviews; absent or 'local' for a local checkout. */
  source?: 'local' | 'github-pr'
  /** The pull request: reviewed (github-pr), or the open PR of a local branch. */
  pr?: { owner: string; name: string; number: number; title?: string; url?: string; author?: string; baseRef?: string }
  review?: { state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'; at: number; url?: string }
}

export const isPrSession = (session: Pick<SessionRecord, 'source'>) => session.source === 'github-pr'

export interface InboxRecord {
  id: string
  fetchedAt: number
  items: { repo: string; number: number; title: string; author: string; url: string; updatedAt: string; section: string }[]
}

export type Severity = 'nit' | 'suggestion' | 'issue' | 'blocker'
export type NoteStatus = 'open' | 'resolved' | 'suggested' | 'dismissed'
/** 'claude' is only on notes from the removed in-app Claude pass. */
export type NoteSource = 'me' | 'claude' | 'mcp'

export interface NoteAnchor {
  line: number
  side: 'old' | 'new'
  text: string
  before: string[]
  after: string[]
}

export interface NoteRecord {
  id: string
  sessionId: string
  path: string
  anchor: NoteAnchor
  body: string
  severity: Severity
  status: NoteStatus
  source: NoteSource
  title?: string
  anchorLost?: boolean
  carriedFrom?: string
  createdAt: number
  updatedAt: number
  resolution?: { by: string; text: string; at: number }
}

export interface ChecklistRecord {
  id: string
  scope: string
  title: string
  items: { id: string; text: string }[]
  required?: boolean
}

export function listRecords<T>(db: Database, kind: SyncKind): T[] {
  return db
    .query<{ id: string; data: string }, [string]>('SELECT id, data FROM records WHERE kind = ? AND deleted = 0')
    .all(kind)
    .map((row) => ({ ...(JSON.parse(row.data) as object), id: row.id }) as T)
}

export function getRecord<T>(db: Database, kind: SyncKind, id: string): T | null {
  const row = db
    .query<{ data: string }, [string, string]>('SELECT data FROM records WHERE kind = ? AND id = ? AND deleted = 0')
    .get(kind, id)
  return row ? ({ ...(JSON.parse(row.data) as object), id } as T) : null
}

export class InvalidRecordError extends Error {}

/** Validates like a pushed change, then writes through `writeRecord`, so the PWA picks it up on its next sync. */
export function saveRecord(db: Database, kind: SyncKind, id: string, record: object, now = Date.now()): void {
  const data: RecordData = {}
  for (const [field, value] of Object.entries(record)) if (field !== 'id' && value !== undefined) data[field] = value
  const error = validateChange({ kind, id, changedAt: now, deleted: false, data })
  if (error) throw new InvalidRecordError(error)
  writeRecord(db, kind, id, data, now)
}

export const repoLabel = (repo: Pick<RepoRecord, 'owner' | 'name'>) => (repo.owner ? `${repo.owner}/${repo.name}` : repo.name)

/** Matches "owner/name" (case-insensitive), a bare name for repos without a GitHub remote, or a repo id. */
export function repoMatches(repo: RepoRecord, query: string): boolean {
  const wanted = query.trim().toLowerCase()
  return repo.id === query || repoLabel(repo).toLowerCase() === wanted || (!repo.owner && repo.name.toLowerCase() === wanted)
}

/** The checklists that apply to a session: global ones first, then the repo's, each by title. */
export function sessionChecklists(lists: ChecklistRecord[], session: SessionRecord): ChecklistRecord[] {
  return lists
    .filter((list) => list.scope === 'global' || list.scope === session.repoId)
    .sort((a, b) => (a.scope === b.scope ? a.title.localeCompare(b.title) : a.scope === 'global' ? -1 : 1))
}

const byNewest = (a: SessionRecord, b: SessionRecord) => b.startedAt - a.startedAt

/**
 * The session the PWA resumes for a repo and branch: the newest active one, else the newest.
 * Local sessions come before pull request sessions of the same branch.
 */
export function currentSession(sessions: SessionRecord[]): SessionRecord | undefined {
  const local = sessions.filter((session) => !isPrSession(session))
  const sorted = [...(local.length ? local : sessions)].sort(byNewest)
  return sorted.find((session) => session.status === 'active') ?? sorted[0]
}

/** The current session of one pull request. */
export function currentPrSession(sessions: SessionRecord[], number: number): SessionRecord | undefined {
  return currentSession(sessions.filter((session) => isPrSession(session) && session.pr?.number === number))
}

/** Read-only snapshot of everything the tools look at, loaded once per request. */
export function loadData(db: Database) {
  const repos = listRecords<RepoRecord>(db, 'repos')
  const sessions = listRecords<SessionRecord>(db, 'sessions')
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  return {
    repos,
    sessions,
    repoById,
    notes: () => listRecords<NoteRecord>(db, 'notes'),
    checklists: () => listRecords<ChecklistRecord>(db, 'checklists'),
    inbox: () => getRecord<InboxRecord>(db, 'inbox', 'inbox'),
    checked: (sessionId: string, itemId: string) =>
      getRecord<{ checked: boolean }>(db, 'checklistState', pairId(sessionId, itemId))?.checked ?? false,
  }
}

export type DataSnapshot = ReturnType<typeof loadData>

/** The repos matching a query and the current session for the branch, if Rubberduck has one. */
export function findBranchSession(data: DataSnapshot, repoQuery: string, branch: string) {
  const repos = data.repos.filter((repo) => repoMatches(repo, repoQuery))
  const repoIds = new Set(repos.map((repo) => repo.id))
  const session = currentSession(data.sessions.filter((s) => repoIds.has(s.repoId) && s.branch === branch))
  return { repos, session }
}
