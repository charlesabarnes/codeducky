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
  }
}

export const db = new SkelbertDb()
