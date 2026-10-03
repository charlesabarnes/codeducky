import type { DiffSide } from '../diff/hunks'
import type { GitHubClient } from './client'
import type { RepoRef, ReviewSide } from './types'

export interface ThreadComment {
  id: string
  databaseId: number | null
  author: string
  body: string
  createdAt: string
  url: string
  /** Part of your pending review: only you can see it until the review is submitted. */
  pending: boolean
}

export interface ReviewThread {
  id: string
  path: string
  /** Line on `side` in the head (new) or merge base (old) version; null when the thread is outdated. */
  line: number | null
  originalLine: number | null
  startLine: number | null
  side: DiffSide
  fileLevel: boolean
  isResolved: boolean
  isOutdated: boolean
  resolvedBy: string | null
  canReply: boolean
  canResolve: boolean
  canUnresolve: boolean
  comments: ThreadComment[]
}

export interface PendingReview {
  id: string
  databaseId: number | null
  body: string
  comments: number
  url: string
}

export interface PullThreads {
  pullId: string
  viewer: string
  threads: ReviewThread[]
  /** Yours, if you have one: GitHub allows one pending review per person per pull request. */
  pendingReview: PendingReview | null
}

const COMMENT_FIELDS = 'id databaseId body createdAt url state author { login }'

export const THREADS_QUERY = `
query Threads($owner: String!, $name: String!, $number: Int!, $after: String) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      pending: reviews(states: PENDING, first: 1) { nodes { id databaseId body url comments { totalCount } } }
      reviewThreads(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id path line originalLine startLine diffSide subjectType isResolved isOutdated
          viewerCanReply viewerCanResolve viewerCanUnresolve
          resolvedBy { login }
          comments(first: 100) { nodes { ${COMMENT_FIELDS} } }
        }
      }
    }
  }
}`

interface RawComment {
  id: string
  databaseId?: number | null
  body: string
  createdAt: string
  url: string
  state?: string
  author?: { login: string } | null
}

interface RawThread {
  id: string
  path: string
  line?: number | null
  originalLine?: number | null
  startLine?: number | null
  diffSide?: ReviewSide | null
  subjectType?: 'LINE' | 'FILE' | null
  isResolved: boolean
  isOutdated: boolean
  viewerCanReply?: boolean
  viewerCanResolve?: boolean
  viewerCanUnresolve?: boolean
  resolvedBy?: { login: string } | null
  comments: { nodes: (RawComment | null)[] }
}

interface RawThreads {
  viewer: { login: string }
  repository: {
    pullRequest: {
      id: string
      pending: { nodes: ({ id: string; databaseId?: number | null; body?: string; url?: string; comments?: { totalCount: number } } | null)[] }
      reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: (RawThread | null)[] }
    } | null
  } | null
}

export const toComment = (raw: RawComment): ThreadComment => ({
  id: raw.id,
  databaseId: raw.databaseId ?? null,
  author: raw.author?.login ?? 'ghost',
  body: raw.body,
  createdAt: raw.createdAt,
  url: raw.url,
  pending: raw.state === 'PENDING',
})

export function toThread(raw: RawThread): ReviewThread {
  return {
    id: raw.id,
    path: raw.path,
    line: raw.isOutdated ? null : (raw.line ?? null),
    originalLine: raw.originalLine ?? null,
    startLine: raw.startLine ?? null,
    side: raw.diffSide === 'LEFT' ? 'old' : 'new',
    fileLevel: raw.subjectType === 'FILE',
    isResolved: raw.isResolved,
    isOutdated: raw.isOutdated,
    resolvedBy: raw.resolvedBy?.login ?? null,
    canReply: raw.viewerCanReply ?? true,
    canResolve: raw.viewerCanResolve ?? false,
    canUnresolve: raw.viewerCanUnresolve ?? false,
    comments: raw.comments.nodes.flatMap((comment) => (comment ? [toComment(comment)] : [])),
  }
}

const MAX_THREAD_PAGES = 20

export async function fetchThreads(gh: GitHubClient, ref: RepoRef, number: number): Promise<PullThreads> {
  const threads: ReviewThread[] = []
  let after: string | null = null
  let result: PullThreads | null = null
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const raw: RawThreads = await gh.graphql<RawThreads>(THREADS_QUERY, { owner: ref.owner, name: ref.name, number, after })
    const pull = raw.repository?.pullRequest
    if (!pull) throw new Error(`Pull request #${number} was not found in ${ref.owner}/${ref.name}.`)
    threads.push(...pull.reviewThreads.nodes.flatMap((node) => (node ? [toThread(node)] : [])))
    const pending = pull.pending.nodes[0]
    result ??= {
      pullId: pull.id,
      viewer: raw.viewer.login,
      threads,
      pendingReview: pending
        ? { id: pending.id, databaseId: pending.databaseId ?? null, body: pending.body ?? '', comments: pending.comments?.totalCount ?? 0, url: pending.url ?? '' }
        : null,
    }
    if (!pull.reviewThreads.pageInfo.hasNextPage) break
    after = pull.reviewThreads.pageInfo.endCursor
  }
  return result!
}

export interface PlacedThreads {
  /** "side:line" → threads shown on that diff line. */
  byLine: Map<string, ReviewThread[]>
  /** Outdated and file-level threads, listed above the file's diff. */
  listed: ReviewThread[]
}

/** Splits one file's threads into those that sit on a line of the current diff and the rest. */
export function placeThreads(threads: readonly ReviewThread[]): PlacedThreads {
  const placed: PlacedThreads = { byLine: new Map(), listed: [] }
  for (const thread of threads) {
    if (thread.fileLevel || thread.line === null) {
      placed.listed.push(thread)
      continue
    }
    const key = `${thread.side}:${thread.line}`
    placed.byLine.set(key, [...(placed.byLine.get(key) ?? []), thread])
  }
  return placed
}

/** Threads in reading order: by file (in the order given), then listed ones first, then by line. */
export function orderThreads(threads: readonly ReviewThread[], paths: readonly string[]): ReviewThread[] {
  const rank = new Map(paths.map((path, index) => [path, index]))
  const position = (thread: ReviewThread) => (thread.line === null || thread.fileLevel ? -1 : thread.line)
  return [...threads]
    .filter((thread) => rank.has(thread.path))
    .sort((a, b) => rank.get(a.path)! - rank.get(b.path)! || position(a) - position(b) || (a.side === b.side ? 0 : a.side === 'old' ? -1 : 1))
}

const REPLY = `mutation Reply($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { ${COMMENT_FIELDS} } }
}`

const RESOLVE = `mutation Resolve($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { id isResolved } } }`
const UNRESOLVE = `mutation Unresolve($thread: ID!) { unresolveReviewThread(input: { threadId: $thread }) { thread { id isResolved } } }`

const ADD_THREAD = `mutation AddThread($review: ID!, $path: String!, $line: Int!, $side: DiffSide!, $body: String!) {
  addPullRequestReviewThread(input: { pullRequestReviewId: $review, path: $path, line: $line, side: $side, body: $body }) {
    thread { id comments(first: 1) { nodes { databaseId } } }
  }
}`

export async function replyToThread(gh: GitHubClient, threadId: string, body: string): Promise<ThreadComment> {
  const data = await gh.graphql<{ addPullRequestReviewThreadReply: { comment: RawComment } | null }>(REPLY, { thread: threadId, body })
  const comment = data.addPullRequestReviewThreadReply?.comment
  if (!comment) throw new Error('GitHub did not return the reply.')
  return toComment(comment)
}

export async function setThreadResolved(gh: GitHubClient, threadId: string, resolved: boolean): Promise<boolean> {
  type Result = { thread: { id: string; isResolved: boolean } } | null
  if (resolved) {
    const data = await gh.graphql<{ resolveReviewThread: Result }>(RESOLVE, { thread: threadId })
    return data.resolveReviewThread?.thread.isResolved ?? true
  }
  const data = await gh.graphql<{ unresolveReviewThread: Result }>(UNRESOLVE, { thread: threadId })
  return data.unresolveReviewThread?.thread.isResolved ?? false
}

/** Adds a comment thread to an existing pending review; returns the new comment's REST id. */
export async function addThreadToReview(
  gh: GitHubClient,
  reviewNodeId: string,
  comment: { path: string; line: number; side: ReviewSide; body: string },
): Promise<number | null> {
  const data = await gh.graphql<{ addPullRequestReviewThread: { thread: { comments: { nodes: { databaseId: number | null }[] } } } | null }>(
    ADD_THREAD,
    { review: reviewNodeId, ...comment },
  )
  return data.addPullRequestReviewThread?.thread.comments.nodes[0]?.databaseId ?? null
}
