import { errorFromResponse, GitHubError, isGitHubError } from './errors'
import type { BranchCommit } from '../git/types'
import type {
  AnnotationLevel,
  BranchFile,
  CheckAnnotation,
  CheckConclusion,
  CheckRun,
  CheckStatus,
  ComparedFile,
  ComparedFileStatus,
  Comparison,
  IssueComment,
  PendingReviewInput,
  PullDetail,
  PullFile,
  PullReview,
  PutFileInput,
  PutFileResult,
  ReviewEvent,
  ReviewInput,
  PullRequest,
  RepoRef,
  RepoSummary,
  Review,
  ReviewComment,
  ReviewSide,
  Tree,
  Viewer,
} from './types'

export const GITHUB_API = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const PAGE_SIZE = 100
const MAX_PAGES = 30

export interface GitHubClientOptions {
  token: string
  fetch?: typeof fetch
  baseUrl?: string
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT'
  query?: Record<string, string | number>
  body?: unknown
  accept?: string
}

interface Response<T> {
  data: T
  headers: Headers
}

interface RawFile {
  filename: string
  previous_filename?: string
  status: ComparedFileStatus
  sha?: string | null
  patch?: string
  additions?: number
  deletions?: number
}

interface RawCommit {
  sha: string
  parents: { sha: string }[]
  commit: { message: string; author: { name?: string; date?: string } | null }
  author?: RawUser | null
}

const toBranchCommit = (raw: RawCommit): BranchCommit => ({
  sha: raw.sha,
  parents: raw.parents.map((parent) => parent.sha),
  message: raw.commit.message.trimEnd(),
  author: raw.commit.author?.name ?? raw.author?.login ?? 'unknown',
  date: raw.commit.author?.date ? Date.parse(raw.commit.author.date) : 0,
})

interface RawPull {
  number: number
  title: string
  html_url: string
  draft?: boolean
  head: { sha: string; ref: string }
  base: { ref: string }
}

interface RawReviewComment {
  id: number
  path: string
  line?: number | null
  side?: ReviewSide | null
  body: string
}

interface RawCheckRun {
  id: number
  name: string
  status: CheckStatus
  conclusion: CheckConclusion | null
  html_url?: string | null
  details_url?: string | null
  output?: { title?: string | null; annotations_count?: number }
  app?: { name?: string } | null
}

interface RawAnnotation {
  path: string
  start_line: number
  end_line?: number | null
  annotation_level: AnnotationLevel
  title?: string | null
  message: string
  raw_details?: string | null
}

const toCheckRun = (run: RawCheckRun): CheckRun => ({
  id: run.id,
  name: run.name,
  status: run.status,
  conclusion: run.conclusion,
  htmlUrl: run.html_url ?? null,
  detailsUrl: run.details_url ?? null,
  title: run.output?.title ?? null,
  annotationsCount: run.output?.annotations_count ?? 0,
  app: run.app?.name ?? null,
})

const toAnnotation = (checkRunId: number, raw: RawAnnotation): CheckAnnotation => ({
  checkRunId,
  path: raw.path,
  startLine: raw.start_line,
  endLine: raw.end_line ?? raw.start_line,
  level: raw.annotation_level,
  title: raw.title || null,
  message: raw.message,
  rawDetails: raw.raw_details || null,
})

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')
const repoPath = ({ owner, name }: RepoRef) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`

function nextLink(headers: Headers): string | null {
  const link = headers.get('link')
  if (!link) return null
  for (const part of link.split(',')) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part)
    if (match?.[1]) return match[1]
  }
  return null
}

export function encodeBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(binary)
}

export function decodeBase64(content: string): Uint8Array {
  const binary = atob(content.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const toPullFile = (file: RawFile): PullFile => ({
  path: file.filename,
  previousPath: file.previous_filename ?? null,
  status: file.status,
  patch: file.patch ?? null,
  sha: file.sha ?? null,
  additions: file.additions ?? 0,
  deletions: file.deletions ?? 0,
})

interface RawUser {
  login: string
  avatar_url?: string
}

interface RawPullDetail extends RawPull {
  body?: string | null
  state: 'open' | 'closed'
  merged?: boolean
  user: RawUser | null
  head: { sha: string; ref: string; repo?: { full_name: string } | null }
  maintainer_can_modify?: boolean
  base: { sha: string; ref: string }
  labels?: { name: string; color?: string }[]
  requested_reviewers?: RawUser[]
  requested_teams?: { slug: string; name?: string }[]
  additions?: number
  deletions?: number
  changed_files?: number
  created_at: string
  updated_at: string
}

const toPullDetail = (pull: RawPullDetail): PullDetail => ({
  ...toPull(pull),
  body: pull.body ?? '',
  state: pull.merged ? 'merged' : pull.state,
  author: pull.user?.login ?? 'ghost',
  baseSha: pull.base.sha,
  headRepo: pull.head.repo?.full_name ?? null,
  maintainerCanModify: Boolean(pull.maintainer_can_modify),
  labels: (pull.labels ?? []).map((label) => ({ name: label.name, color: label.color ?? null })),
  requestedReviewers: (pull.requested_reviewers ?? []).map((user) => user.login),
  requestedTeams: (pull.requested_teams ?? []).map((team) => team.slug),
  additions: pull.additions ?? 0,
  deletions: pull.deletions ?? 0,
  changedFiles: pull.changed_files ?? 0,
  createdAt: pull.created_at,
  updatedAt: pull.updated_at,
})

interface RawReview {
  id: number
  node_id?: string
  user: RawUser | null
  state: string
  body?: string | null
  submitted_at?: string | null
  html_url: string
  commit_id?: string | null
}

const toPullReview = (review: RawReview): PullReview => ({
  id: review.id,
  nodeId: review.node_id ?? null,
  author: review.user?.login ?? 'ghost',
  state: review.state,
  body: review.body ?? '',
  submittedAt: review.submitted_at ?? null,
  htmlUrl: review.html_url,
  commitId: review.commit_id ?? null,
})

interface RawIssueComment {
  id: number
  user: RawUser | null
  body?: string | null
  created_at: string
  updated_at: string
  html_url: string
}

/** The GraphQL error types GitHub sends, mapped onto the REST error kinds. */
function graphqlError(errors: { type?: string; message?: string }[]): GitHubError {
  const first = errors[0] ?? {}
  const text = errors.map((error) => error.message).filter(Boolean).join('; ')
  switch (first.type) {
    case 'NOT_FOUND':
      return new GitHubError('not-found', 404, `Not found on GitHub. ${text}`)
    case 'FORBIDDEN':
      return new GitHubError(
        'forbidden',
        403,
        `GitHub refused access. ${text} A fine-grained token must include this repository, with Pull requests: read and write.`,
      )
    case 'RATE_LIMITED':
      return new GitHubError('rate-limited', 403, `GitHub rate limit reached. ${text}`)
    default:
      if (/not accessible by (personal access|integration)/i.test(text)) {
        return new GitHubError('forbidden', 403, `GitHub refused access. ${text}`)
      }
      return new GitHubError('invalid', 422, `GitHub rejected the request. ${text}`)
  }
}

export interface GraphqlOptions {
  /** Return partial data when only some fields failed (e.g. a repository the token cannot see). */
  partial?: boolean
}

const toComparedFile = (file: RawFile): ComparedFile => ({
  path: file.filename,
  previousPath: file.previous_filename ?? null,
  status: file.status,
  sha: file.sha ?? null,
})

const toPull = (pull: RawPull): PullRequest => ({
  number: pull.number,
  title: pull.title,
  htmlUrl: pull.html_url,
  draft: Boolean(pull.draft),
  headSha: pull.head.sha,
  headRef: pull.head.ref,
  baseRef: pull.base.ref,
})

async function orNull<T>(promise: Promise<T>, ...statuses: number[]): Promise<T | null> {
  try {
    return await promise
  } catch (error) {
    if (isGitHubError(error) && statuses.includes(error.status)) return null
    throw error
  }
}

export function createGitHubClient({ token, fetch: fetchImpl = globalThis.fetch, baseUrl = GITHUB_API }: GitHubClientOptions) {
  const doFetch = fetchImpl.bind(globalThis)

  async function request<T>(
    path: string,
    { method = 'GET', query, body, accept = 'application/vnd.github+json' }: RequestOptions = {},
  ): Promise<Response<T>> {
    const url = new URL(path.startsWith('http') ? path : `${baseUrl}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value))
    const headers: Record<string, string> = {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    let response: globalThis.Response
    try {
      response = await doFetch(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new GitHubError('network', 0, `Could not reach GitHub: ${reason}`)
    }
    if (!response.ok) {
      const errorBody = await response.json().catch(() => null)
      throw errorFromResponse(response.status, response.headers, errorBody)
    }
    return { data: (await response.json()) as T, headers: response.headers }
  }

  /** Follows `link: rel="next"`; `pick` takes the items out of each page (for wrapped lists). */
  async function paginate<T, P = T[]>(
    path: string,
    query: Record<string, string | number> = {},
    pick: (page: P) => T[] = (page) => page as unknown as T[],
  ): Promise<T[]> {
    const items: T[] = []
    let next: string | null = path
    let first = true
    for (let page = 0; next && page < MAX_PAGES; page++) {
      const response: Response<P> = await request<P>(next, first ? { query: { per_page: PAGE_SIZE, ...query } } : {})
      items.push(...pick(response.data))
      next = nextLink(response.headers)
      first = false
    }
    return items
  }

  async function blob(repo: RepoRef, sha: string): Promise<Uint8Array> {
    const { data } = await request<{ content: string; encoding: string }>(`${repoPath(repo)}/git/blobs/${sha}`)
    if (data.encoding === 'base64') return decodeBase64(data.content)
    return new TextEncoder().encode(data.content)
  }

  /** Creates a review; with an `event` it is submitted in the same call, without one it stays pending. */
  async function createReview(repo: RepoRef, number: number, input: ReviewInput): Promise<Review> {
    const body: Record<string, unknown> = {
      commit_id: input.commitId,
      body: input.body,
      comments: input.comments.map(({ path, line, side, startLine, startSide, body }) =>
        startLine === undefined ? { path, line, side, body } : { path, start_line: startLine, start_side: startSide ?? side, line, side, body },
      ),
    }
    if (input.event) body.event = input.event
    const { data } = await request<{ id: number; state: string; html_url: string }>(`${repoPath(repo)}/pulls/${number}/reviews`, {
      method: 'POST',
      body,
    })
    return { id: data.id, state: data.state, htmlUrl: data.html_url }
  }

  return {
    async viewer(): Promise<Viewer> {
      const { data, headers } = await request<{ login: string; name?: string | null }>('/user')
      const scopes = headers.get('x-oauth-scopes')
      return {
        login: data.login,
        name: data.name ?? null,
        tokenExpiresAt: headers.get('github-authentication-token-expiration'),
        scopes: scopes === null ? null : scopes.split(',').map((s) => s.trim()).filter(Boolean),
      }
    },

    async repo(repo: RepoRef): Promise<RepoSummary> {
      const { data } = await request<{
        full_name: string
        default_branch: string
        private: boolean
        html_url: string
        permissions?: { push?: boolean }
      }>(repoPath(repo))
      return {
        fullName: data.full_name,
        defaultBranch: data.default_branch,
        private: data.private,
        htmlUrl: data.html_url,
        canPush: data.permissions?.push ?? null,
      }
    },

    /** A file as it is on a branch now. */
    async fileAt(repo: RepoRef, path: string, branch: string): Promise<BranchFile> {
      const { data } = await request<{ sha: string; content?: string; encoding?: string }>(
        `${repoPath(repo)}/contents/${encodePath(path)}`,
        // Files over 1 MB need the object media type; they come without content and are read as blobs.
        { query: { ref: branch }, accept: 'application/vnd.github.object+json' },
      )
      const bytes = data.encoding === 'base64' && data.content !== undefined ? decodeBase64(data.content) : await blob(repo, data.sha)
      return { sha: data.sha, bytes }
    },

    /** Commits one file to a branch through the contents API. */
    async putFile(repo: RepoRef, path: string, input: PutFileInput): Promise<PutFileResult> {
      const { data } = await request<{ content: { sha: string }; commit: { sha: string } }>(
        `${repoPath(repo)}/contents/${encodePath(path)}`,
        { method: 'PUT', body: { message: input.message, content: encodeBase64(input.content), sha: input.sha, branch: input.branch } },
      )
      return { commitSha: data.commit.sha, blobSha: data.content.sha }
    },

    /** The commit a branch points at, or null when GitHub has no such branch. */
    async branchHead(repo: RepoRef, branch: string): Promise<string | null> {
      const ref = await orNull(
        request<{ object: { sha: string } }>(`${repoPath(repo)}/git/ref/heads/${encodePath(branch)}`),
        404,
      )
      return ref?.data.object.sha ?? null
    },

    async commitExists(repo: RepoRef, sha: string): Promise<boolean> {
      const commit = await orNull(request<{ sha: string }>(`${repoPath(repo)}/commits/${sha}`), 404, 422)
      return commit !== null
    },

    async compare(repo: RepoRef, base: string, head: string): Promise<Comparison> {
      const { data } = await request<{
        status: Comparison['status']
        ahead_by: number
        behind_by: number
        merge_base_commit: { sha: string }
        files?: RawFile[]
      }>(`${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`)
      return {
        status: data.status,
        aheadBy: data.ahead_by,
        behindBy: data.behind_by,
        mergeBaseSha: data.merge_base_commit.sha,
        files: (data.files ?? []).map(toComparedFile),
      }
    },

    async tree(repo: RepoRef, sha: string): Promise<Tree> {
      const { data } = await request<{ sha: string; truncated: boolean; tree: Tree['entries'] }>(
        `${repoPath(repo)}/git/trees/${sha}`,
        { query: { recursive: 1 } },
      )
      return { sha: data.sha, truncated: data.truncated, entries: data.tree }
    },

    blob,

    /** The open pull request from `branch`, which lives in the repo itself or, with `headOwner`, in that owner's fork. */
    async openPullForBranch(repo: RepoRef, branch: string, headOwner = repo.owner): Promise<PullRequest | null> {
      const { data } = await request<RawPull[]>(`${repoPath(repo)}/pulls`, {
        query: { head: `${headOwner}:${branch}`, state: 'open', per_page: 10 },
      })
      return data[0] ? toPull(data[0]) : null
    },

    /** The pull request's commits, oldest first (GitHub lists at most 250). */
    async pullCommits(repo: RepoRef, number: number): Promise<BranchCommit[]> {
      return (await paginate<RawCommit>(`${repoPath(repo)}/pulls/${number}/commits`)).map(toBranchCommit)
    },

    /** The files between two commits, with line counts and patches (three-dot: from their merge base). */
    async compareFiles(repo: RepoRef, base: string, head: string): Promise<PullFile[]> {
      const { data } = await request<{ files?: RawFile[] }>(
        `${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      )
      return (data.files ?? []).map(toPullFile)
    },

    async pullFiles(repo: RepoRef, number: number): Promise<PullFile[]> {
      return (await paginate<RawFile>(`${repoPath(repo)}/pulls/${number}/files`)).map(toPullFile)
    },

    /** Creates a PENDING review: no `event`, so nothing is published until the author submits it on GitHub. */
    async createPendingReview(repo: RepoRef, number: number, input: PendingReviewInput): Promise<Review> {
      return createReview(repo, number, input)
    },

    createReview,

    /** Submits a pending review. */
    async submitReview(repo: RepoRef, number: number, reviewId: number, event: ReviewEvent, body: string): Promise<Review> {
      const { data } = await request<{ id: number; state: string; html_url: string }>(
        `${repoPath(repo)}/pulls/${number}/reviews/${reviewId}/events`,
        { method: 'POST', body: { event, body } },
      )
      return { id: data.id, state: data.state, htmlUrl: data.html_url }
    },

    async updateReviewBody(repo: RepoRef, number: number, reviewId: number, body: string): Promise<void> {
      await request(`${repoPath(repo)}/pulls/${number}/reviews/${reviewId}`, { method: 'PUT', body: { body } })
    },

    async pull(repo: RepoRef, number: number): Promise<PullDetail> {
      return toPullDetail((await request<RawPullDetail>(`${repoPath(repo)}/pulls/${number}`)).data)
    },

    /** Submitted reviews, oldest first (pending reviews of other people are never listed). */
    async pullReviews(repo: RepoRef, number: number): Promise<PullReview[]> {
      return (await paginate<RawReview>(`${repoPath(repo)}/pulls/${number}/reviews`)).map(toPullReview)
    },

    /** The pull request's conversation: comments that are not on a line. */
    async issueComments(repo: RepoRef, number: number): Promise<IssueComment[]> {
      const comments = await paginate<RawIssueComment>(`${repoPath(repo)}/issues/${number}/comments`)
      return comments.map((c) => ({
        id: c.id,
        author: c.user?.login ?? 'ghost',
        body: c.body ?? '',
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        htmlUrl: c.html_url,
      }))
    },

    async graphql<T>(query: string, variables: Record<string, unknown> = {}, options: GraphqlOptions = {}): Promise<T> {
      const { data } = await request<{ data?: T | null; errors?: { type?: string; message?: string }[] }>('/graphql', {
        method: 'POST',
        body: { query, variables },
      })
      if (data.errors?.length && (!options.partial || !data.data)) throw graphqlError(data.errors)
      if (!data.data) throw new GitHubError('invalid', 422, 'GitHub returned no data.')
      return data.data
    },

    /** Check runs for a commit, or null when GitHub does not have the commit. */
    async checkRuns(repo: RepoRef, sha: string): Promise<CheckRun[] | null> {
      const runs = await orNull(
        paginate<RawCheckRun, { check_runs: RawCheckRun[] }>(`${repoPath(repo)}/commits/${encodeURIComponent(sha)}/check-runs`, {}, (page) => page.check_runs),
        404,
        422,
      )
      return runs?.map(toCheckRun) ?? null
    },

    async checkRunAnnotations(repo: RepoRef, checkRunId: number): Promise<CheckAnnotation[]> {
      const raw = await paginate<RawAnnotation>(`${repoPath(repo)}/check-runs/${checkRunId}/annotations`)
      return raw.map((annotation) => toAnnotation(checkRunId, annotation))
    },

    async reviewComments(repo: RepoRef, number: number, reviewId: number): Promise<ReviewComment[]> {
      const comments = await paginate<RawReviewComment>(`${repoPath(repo)}/pulls/${number}/reviews/${reviewId}/comments`)
      return comments.map((c) => ({ id: c.id, path: c.path, line: c.line ?? null, side: c.side ?? null, body: c.body }))
    },
  }
}

export type GitHubClient = ReturnType<typeof createGitHubClient>
