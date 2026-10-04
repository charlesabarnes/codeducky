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
  /** Whether the token's user can push, or null when GitHub does not say (an unauthenticated view). */
  canPush: boolean | null
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
  /** Blob of the head version; for removed files GitHub may send the base blob or nothing. */
  sha?: string | null
  additions?: number
  deletions?: number
}

export interface PullLabel {
  name: string
  color: string | null
}

export interface PullDetail extends PullRequest {
  body: string
  state: 'open' | 'closed' | 'merged'
  author: string
  /** The base branch tip when the PR was last updated (not the merge base). */
  baseSha: string
  /** "owner/name" of the head repository; null when the fork is gone. */
  headRepo: string | null
  /** The fork's owner lets maintainers of the base repository push to the head branch. */
  maintainerCanModify: boolean
  labels: PullLabel[]
  requestedReviewers: string[]
  requestedTeams: string[]
  additions: number
  deletions: number
  changedFiles: number
  createdAt: string
  updatedAt: string
}

export interface PullReview {
  id: number
  nodeId: string | null
  author: string
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED or PENDING. */
  state: string
  body: string
  submittedAt: string | null
  htmlUrl: string
  commitId: string | null
}

export interface IssueComment {
  id: number
  author: string
  body: string
  createdAt: string
  updatedAt: string
  htmlUrl: string
}

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'

export interface ReviewInput extends PendingReviewInput {
  /** Submits the review in the same call; without it the review stays pending. */
  event?: ReviewEvent
}

export type ReviewSide = 'LEFT' | 'RIGHT'

export interface ReviewCommentInput {
  path: string
  /** The last line of a multi-line comment. */
  line: number
  side: ReviewSide
  /** The first line of a multi-line comment. */
  startLine?: number
  startSide?: ReviewSide
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

/** A file on a branch, as the contents API returns it. */
export interface BranchFile {
  sha: string
  bytes: Uint8Array
}

export interface PutFileInput {
  branch: string
  message: string
  content: Uint8Array
  /** The blob being replaced; GitHub refuses the write when the branch has another one. */
  sha: string
}

export interface PutFileResult {
  commitSha: string
  blobSha: string
}
