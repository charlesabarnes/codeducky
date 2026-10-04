export type BaseSource = 'local' | 'github'
/**
 * Where a session's diff comes from: a local checkout, a pull request read through the GitHub API, or a patch file
 * (kept on this device, never synced).
 */
export type SessionSource = 'local' | 'github-pr' | 'patch'
export type SubmittedReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'
export type SessionStatus = 'active' | 'archived'
export type NoteSide = 'old' | 'new'
export type NoteSeverity = 'nit' | 'suggestion' | 'issue' | 'blocker'
export type NoteStatus = 'open' | 'resolved' | 'suggested' | 'dismissed'
/** 'claude' marks notes from the removed in-app Claude pass; they stay readable but none are created. */
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
  /** Review instructions for this repo, served to Claude over MCP. */
  instructions?: string
  /** Legacy name of `instructions`, still read from records synced before the rename. */
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

/** One changed file as the last scan saw it; synced so MCP clients get the shape of the diff. */
export interface SessionFile {
  path: string
  status: string
  additions?: number
  deletions?: number
  binary?: boolean
}

export interface Session extends Synced {
  id?: string
  repoId: string
  branch: string
  headSha: string
  baseSha: string
  baseSource: BaseSource
  /**
   * Set when baseSource is 'github': the GitHub base branch tip the merge base was computed from, and
   * `pushedSha`, the last pushed ancestor compared against it when HEAD is not on GitHub.
   */
  githubBase?: { branch: string; tipSha: string; pushedSha?: string }
  /** Why a resumed GitHub-base session went back to the local base. */
  baseNotice?: string
  startedAt: number
  status: SessionStatus
  files?: SessionFile[]
  /** Absent on sessions made before pull request review; they are local. */
  source?: SessionSource
  /** Set when source is 'github-pr'. `branch` holds the head branch and `headSha` the head commit reviewed. */
  pr?: SessionPullRequest
  /** The review submitted from this session, which archived it. */
  review?: { state: SubmittedReviewState; at: number; url?: string }
  /** The head commit when a file was last marked viewed, or the session was archived or submitted: "since last look" starts here. */
  lastReview?: LastReview
}

export interface LastReview {
  headSha: string
  at: number
}

export interface SessionPullRequest {
  owner: string
  name: string
  number: number
  title?: string
  url?: string
  author?: string
  baseRef?: string
}

export const isPrSession = (session: Pick<Session, 'source'>) => session.source === 'github-pr'

export const isPatchSession = (session: Pick<Session, 'source'>) => session.source === 'patch'

/** The text of a patch session's file. Local only, like the session. */
export interface StoredPatch {
  sessionId: string
  name: string
  text: string
}

export interface FileView extends Synced {
  sessionId: string
  path: string
  contentHash: string
  viewed: boolean
  /**
   * The blob oid of the content last reviewed (marked viewed, or covered by a submitted review). Kept when the file
   * is unmarked or changes, so "since last look" can diff from it. Only the hash syncs; uncommitted content is
   * snapshotted on this device in `reviewSnapshots`.
   */
  reviewedOid?: string
  /** The head commit at that moment. */
  reviewedHead?: string
  reviewedAt?: number
}

/** Uncommitted file content as it was when reviewed, keyed by blob oid. Local only, never synced; pruned by size and age. */
export interface ReviewSnapshot {
  oid: string
  bytes: Uint8Array
  size: number
  /** Last written or read, for LRU pruning. */
  at: number
}

export interface NoteAnchor {
  /** The line, or the first line of a range. */
  line: number
  side: NoteSide
  /** The text of `line`. */
  text: string
  before: string[]
  after: string[]
  /** The last line of a multi-line note; absent on a single line. */
  endLine?: number
  /** With endLine: the text of every line from `line` to `endLine` (empty on a line-only anchor from MCP). */
  rangeText?: string[]
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
  /**
   * Set when the note was made on a commit's version of the file and its line is gone from the final content:
   * the anchor is on that commit's lines, so it is shown when that commit is picked, and never re-anchored.
   */
  commit?: string
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
  /** Unticked items block a push through the pre-push gate. */
  required?: boolean
}

export interface ChecklistState extends Synced {
  sessionId: string
  itemId: string
  checked: boolean
}

export type InboxSection = 'requested' | 'mine' | 'reviewed'

/** One pull request in the inbox, as synced for MCP clients (list_review_requests). */
export interface InboxItem {
  repo: string
  number: number
  title: string
  author: string
  url: string
  updatedAt: string
  section: InboxSection
}

/** The last inbox fetched on any device: one record, id INBOX_ID. */
export interface InboxSnapshot extends Synced {
  id: string
  fetchedAt: number
  items: InboxItem[]
}

export const INBOX_ID = 'inbox'

/** Blob contents fetched from GitHub for pull request sessions; local only, pruned by age. */
export interface CachedBlob {
  oid: string
  bytes: Uint8Array
  at: number
}

export const THEME_PREFERENCES = ['dark', 'light', 'system'] as const
export type ThemePreference = (typeof THEME_PREFERENCES)[number]
export const PALETTES = ['terminal', 'fjord', 'solar', 'dusk', 'contrast'] as const
export type Palette = (typeof PALETTES)[number]
export const DENSITIES = ['compact', 'default', 'comfortable'] as const
export type Density = (typeof DENSITIES)[number]
export const CODE_FONTS = ['plex', 'jetbrains', 'system'] as const
export type CodeFont = (typeof CODE_FONTS)[number]

export interface Settings {
  id: 'app'
  githubPat: string
  theme?: ThemePreference
  palette?: Palette
  density?: Density
  codeFont?: CodeFont
}
