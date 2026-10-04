import { Dexie, type EntityTable, type Table } from 'dexie'
import { dropClaudePass } from './dropClaudePass'
import { migrateToStringIds, restoreFromStaging } from '../sync/migrateIds'
import { syncMiddleware } from '../sync/middleware'
import type { MetaEntry, OutboxEntry, RejectedEntry } from '../sync/types'
import type {
  CachedBlob,
  Checklist,
  ChecklistState,
  FileView,
  InboxSnapshot,
  Note,
  Repo,
  RepoHandle,
  ReviewSnapshot,
  Session,
  Settings,
} from './schema'

export class RubberduckDb extends Dexie {
  repos!: EntityTable<Repo, 'id'>
  repoHandles!: Table<RepoHandle, string>
  sessions!: EntityTable<Session, 'id'>
  fileViews!: Table<FileView, [string, string]>
  notes!: EntityTable<Note, 'id'>
  checklists!: EntityTable<Checklist, 'id'>
  checklistState!: Table<ChecklistState, [string, string]>
  settings!: EntityTable<Settings, 'id'>
  inbox!: EntityTable<InboxSnapshot, 'id'>
  githubBlobs!: Table<CachedBlob, string>
  reviewSnapshots!: Table<ReviewSnapshot, string>
  outbox!: Table<OutboxEntry, string>
  rejected!: Table<RejectedEntry, string>
  syncMeta!: Table<MetaEntry, string>

  constructor(name = 'rubberduck') {
    super(name)
    this.version(1).stores({
      repos: '++id, [owner+name], lastOpenedAt',
      sessions: '++id, repoId, [repoId+branch], startedAt, status',
      fileViews: '[sessionId+path], sessionId',
      notes: '++id, sessionId, [sessionId+path], status',
      checklists: '++id, scope',
      checklistState: '[sessionId+itemId], sessionId',
      settings: 'id',
    })
    this.version(2).upgrade((tx) =>
      tx
        .table<Note>('notes')
        .toCollection()
        .modify((note) => {
          const legacy = note.severity as string
          if (legacy === 'info') note.severity = 'suggestion'
          if (legacy === 'warning') note.severity = 'issue'
          note.createdAt ??= Date.now()
          note.updatedAt ??= note.createdAt
        }),
    )
    // Numeric auto-increment ids become global string ids. IndexedDB cannot change a primary key
    // in place, so v3 copies into staging tables (rewriting references) and drops the originals,
    // and v4 recreates them and copies back.
    this.version(3)
      .stores({
        repos: null,
        sessions: null,
        notes: null,
        checklists: null,
        stagingRepos: 'id',
        stagingSessions: 'id',
        stagingNotes: 'id',
        stagingChecklists: 'id',
        repoHandles: 'repoId',
        outbox: 'key, changedAt',
        rejected: 'key, at',
        syncMeta: 'key',
      })
      .upgrade(migrateToStringIds)
    this.version(4)
      .stores({
        repos: 'id, [owner+name], lastOpenedAt',
        sessions: 'id, repoId, [repoId+branch], startedAt, status',
        notes: 'id, sessionId, [sessionId+path], status',
        checklists: 'id, scope',
        stagingRepos: null,
        stagingSessions: null,
        stagingNotes: null,
        stagingChecklists: null,
      })
      .upgrade(restoreFromStaging)
    this.version(5).upgrade(dropClaudePass)
    this.version(6).stores({ inbox: 'id', githubBlobs: 'oid, at' })
    // Local only: not a sync kind, so the sync middleware leaves it alone.
    this.version(7).stores({ reviewSnapshots: 'oid, at, [at+size]' })
    this.use(syncMiddleware)
  }
}

export const db = new RubberduckDb()
