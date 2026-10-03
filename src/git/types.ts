export type ChangeStatus = 'added' | 'modified' | 'deleted'

export interface FileChange {
  path: string
  status: ChangeStatus
  oldOid: string | null
  newOid: string | null
  /** Set for renames (status 'modified'): the path on the base side. */
  oldPath?: string
  /** For renames: content similarity, 50–100. */
  similarity?: number
}

/** How a change reads in the UI: a rename is a modification whose path changed. */
export type ChangeKind = ChangeStatus | 'renamed'

export const changeKind = (change: Pick<FileChange, 'status' | 'oldPath'>): ChangeKind =>
  change.oldPath !== undefined ? 'renamed' : change.status

export interface RenameResult {
  changes: FileChange[]
  /** Only exact renames were looked for, because the change set is too large to compare contents. */
  limited: boolean
}

export interface RepoInfo {
  owner: string | null
  name: string | null
  remoteUrl: string | null
  branch: string | null
  headSha: string
  baseBranches: string[]
  defaultBase: string | null
}

export interface BaseResolution {
  baseBranch: string
  baseTipSha: string
  mergeBaseSha: string
}

export type FileSide =
  | { kind: 'text'; text: string; size: number }
  | { kind: 'binary'; size: number }
  | { kind: 'too-large'; size: number }

export interface FileContents {
  path: string
  old: FileSide | null
  new: FileSide | null
}

export interface LineCounts {
  additions: number
  deletions: number
}

export type FileStats = LineCounts | { binary: true } | { tooLarge: true }
