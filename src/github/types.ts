export interface RepoRef {
  owner: string
  name: string
}

export interface Viewer {
  login: string
  name: string | null
  /** Raw `github-authentication-token-expiration` header, when GitHub sends one. */
  tokenExpiresAt: string | null
  /** Classic tokens list their scopes; fine-grained tokens do not. */
  scopes: string[] | null
}

export interface RepoSummary {
  fullName: string
  defaultBranch: string
  private: boolean
  htmlUrl: string
}

export type ComparedFileStatus = 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged'

export interface ComparedFile {
  path: string
  previousPath: string | null
  status: ComparedFileStatus
  sha: string | null
}

export interface Comparison {
  status: 'diverged' | 'ahead' | 'behind' | 'identical'
  aheadBy: number
  behindBy: number
  mergeBaseSha: string
  files: ComparedFile[]
}

export interface TreeEntry {
  path: string
  type: 'blob' | 'tree' | 'commit'
  sha: string
  mode: string
}

export interface Tree {
  sha: string
  truncated: boolean
  entries: TreeEntry[]
}

export interface PullRequest {
  number: number
  title: string
  htmlUrl: string
  draft: boolean
  headSha: string
  headRef: string
  baseRef: string
}

export interface PullFile {
  path: string
  previousPath: string | null
  status: ComparedFileStatus
  /** Absent for binary files and very large diffs. */
  patch: string | null
}

export type ReviewSide = 'LEFT' | 'RIGHT'

export interface ReviewCommentInput {
  path: string
  line: number
  side: ReviewSide
  body: string
}

export interface PendingReviewInput {
  commitId: string
  body: string
  comments: ReviewCommentInput[]
}

export interface Review {
  id: number
  state: string
  htmlUrl: string
}

export interface ReviewComment {
  id: number
  path: string
  line: number | null
  side: ReviewSide | null
  body: string
}

export type CheckStatus = 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending'
export type CheckConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | 'stale'

export interface CheckRun {
  id: number
  name: string
  status: CheckStatus
  conclusion: CheckConclusion | null
  htmlUrl: string | null
  detailsUrl: string | null
  title: string | null
  annotationsCount: number
  app: string | null
}

export type AnnotationLevel = 'notice' | 'warning' | 'failure'

export interface CheckAnnotation {
  checkRunId: number
  path: string
  startLine: number
  endLine: number
  level: AnnotationLevel
  title: string | null
  message: string
  rawDetails: string | null
}
