import { Dexie, type EntityTable, type Table } from 'dexie'
import type {
  Checklist,
  ChecklistState,
  FileView,
  Note,
  Repo,
  Session,
  Settings,
} from './schema'

export class SkelbertDb extends Dexie {
  repos!: EntityTable<Repo, 'id'>
  sessions!: EntityTable<Session, 'id'>
  fileViews!: Table<FileView, [number, string]>
  notes!: EntityTable<Note, 'id'>
  checklists!: EntityTable<Checklist, 'id'>
  checklistState!: Table<ChecklistState, [number, string]>
  settings!: EntityTable<Settings, 'id'>

  constructor(name = 'skelbert') {
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
  }
}

export const db = new SkelbertDb()
