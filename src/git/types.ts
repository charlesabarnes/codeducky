export type ChangeStatus = 'added' | 'modified' | 'deleted'

export interface FileChange {
  path: string
  status: ChangeStatus
  oldOid: string | null
  newOid: string | null
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
