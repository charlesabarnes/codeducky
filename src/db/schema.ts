export type BaseSource = 'local' | 'github'
export type SessionStatus = 'active' | 'archived'
export type NoteSide = 'old' | 'new'
export type NoteSeverity = 'nit' | 'suggestion' | 'issue' | 'blocker'
export type NoteStatus = 'open' | 'resolved' | 'suggested' | 'dismissed'
export type NoteSource = 'me' | 'claude'

export interface Repo {
  id?: number
  dirHandle: FileSystemDirectoryHandle
  owner: string
  name: string
  folderName: string
  baseBranch: string
  checklistIds: number[]
  lastOpenedAt: number
}

export interface Session {
  id?: number
  repoId: number
  branch: string
  headSha: string
  baseSha: string
  baseSource: BaseSource
  /** Set when baseSource is 'github': the GitHub base branch tip the merge base was computed from. */
  githubBase?: { branch: string; tipSha: string }
  startedAt: number
  status: SessionStatus
}

export interface FileView {
  sessionId: number
  path: string
  contentHash: string
  viewed: boolean
}

export interface NoteAnchor {
  line: number
  side: NoteSide
  text: string
  before: string[]
  after: string[]
}

export interface Note {
  id?: number
  sessionId: number
  path: string
  anchor: NoteAnchor
  body: string
  severity: NoteSeverity
  status: NoteStatus
  source: NoteSource
  anchorLost?: boolean
  carriedFrom?: number
  createdAt: number
  updatedAt: number
  github?: { reviewId?: number; commentId?: number }
}

export const NOTE_SEVERITIES: readonly NoteSeverity[] = ['nit', 'suggestion', 'issue', 'blocker']

export type ChecklistScope = 'global' | number

export interface ChecklistItem {
  id: string
  text: string
}

export interface Checklist {
  id?: number
  scope: ChecklistScope
  title: string
  items: ChecklistItem[]
}

export interface ChecklistState {
  sessionId: number
  itemId: string
  checked: boolean
}

export interface Settings {
  id: 'app'
  githubPat: string
  anthropicKey: string
  claudeModel: string
}
