export type BaseSource = 'local' | 'github'
export type SessionStatus = 'active' | 'archived'
export type NoteSide = 'old' | 'new'
export type NoteSeverity = 'nit' | 'suggestion' | 'issue' | 'blocker'
export type NoteStatus = 'open' | 'resolved' | 'suggested' | 'dismissed'
export type NoteSource = 'me' | 'claude' | 'mcp'

/** Last-write-wins clock, stamped on every local write by the sync middleware (src/sync/middleware.ts). */
export interface Synced {
  changedAt?: number
}

/** Synced across devices. The folder handle is device-local and lives in `repoHandles`. */
export interface Repo extends Synced {
  id?: string
  owner: string
  name: string
  folderName: string
  baseBranch: string
  checklistIds: string[]
  lastOpenedAt: number
  claudeInstructions?: string
}

/** A repo with this device's folder handle, as the pages that read the working tree need it. */
export interface OpenedRepo extends Repo {
  id: string
  dirHandle: FileSystemDirectoryHandle
}

export interface RepoHandle {
  repoId: string
  dirHandle: FileSystemDirectoryHandle
}

export interface Session extends Synced {
  id?: string
  repoId: string
  branch: string
  headSha: string
  baseSha: string
  baseSource: BaseSource
  /** Set when baseSource is 'github': the GitHub base branch tip the merge base was computed from. */
  githubBase?: { branch: string; tipSha: string }
  startedAt: number
  status: SessionStatus
}

export interface FileView extends Synced {
  sessionId: string
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

export interface NoteResolution {
  by: string
  text: string
  at: number
}

export interface Note extends Synced {
  id?: string
  sessionId: string
  path: string
  anchor: NoteAnchor
  body: string
  severity: NoteSeverity
  status: NoteStatus
  source: NoteSource
  title?: string
  anchorLost?: boolean
  carriedFrom?: string
  createdAt: number
  updatedAt: number
  github?: { reviewId?: number; commentId?: number }
  /** A reply that closed the note, e.g. from Claude Code over MCP. */
  resolution?: NoteResolution
}

export const NOTE_SEVERITIES: readonly NoteSeverity[] = ['nit', 'suggestion', 'issue', 'blocker']

/** 'global', or the id of the repo the checklist belongs to. */
export type ChecklistScope = 'global' | string

export interface ChecklistItem {
  id: string
  text: string
}

export interface Checklist extends Synced {
  id?: string
  scope: ChecklistScope
  title: string
  items: ChecklistItem[]
}

export interface ChecklistState extends Synced {
  sessionId: string
  itemId: string
  checked: boolean
}

export interface Settings {
  id: 'app'
  githubPat: string
  anthropicKey: string
  claudeModel: string
}
