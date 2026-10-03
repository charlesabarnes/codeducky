import { errorFromResponse, GitHubError, isGitHubError } from './errors'
import type {
  ComparedFile,
  ComparedFileStatus,
  Comparison,
  PendingReviewInput,
  PullFile,
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
  method?: 'GET' | 'POST'
  query?: Record<string, string | number>
  body?: unknown
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
}

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
})

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

  async function request<T>(path: string, { method = 'GET', query, body }: RequestOptions = {}): Promise<Response<T>> {
    const url = new URL(path.startsWith('http') ? path : `${baseUrl}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value))
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
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

  async function paginate<T>(path: string, query: Record<string, string | number> = {}): Promise<T[]> {
    const items: T[] = []
    let next: string | null = path
    let first = true
    for (let page = 0; next && page < MAX_PAGES; page++) {
      const response: Response<T[]> = await request<T[]>(next, first ? { query: { per_page: PAGE_SIZE, ...query } } : {})
      items.push(...response.data)
      next = nextLink(response.headers)
      first = false
    }
    return items
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
      const { data } = await request<{ full_name: string; default_branch: string; private: boolean; html_url: string }>(
        repoPath(repo),
      )
      return { fullName: data.full_name, defaultBranch: data.default_branch, private: data.private, htmlUrl: data.html_url }
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

    async blob(repo: RepoRef, sha: string): Promise<Uint8Array> {
      const { data } = await request<{ content: string; encoding: string }>(`${repoPath(repo)}/git/blobs/${sha}`)
      if (data.encoding === 'base64') return decodeBase64(data.content)
      return new TextEncoder().encode(data.content)
    },

    async openPullForBranch(repo: RepoRef, branch: string): Promise<PullRequest | null> {
      const { data } = await request<RawPull[]>(`${repoPath(repo)}/pulls`, {
        query: { head: `${repo.owner}:${branch}`, state: 'open', per_page: 10 },
      })
      return data[0] ? toPull(data[0]) : null
    },

    async pullFiles(repo: RepoRef, number: number): Promise<PullFile[]> {
      return (await paginate<RawFile>(`${repoPath(repo)}/pulls/${number}/files`)).map(toPullFile)
    },

    /** Creates a PENDING review: no `event`, so nothing is published until the author submits it on GitHub. */
    async createPendingReview(repo: RepoRef, number: number, input: PendingReviewInput): Promise<Review> {
      const { data } = await request<{ id: number; state: string; html_url: string }>(
        `${repoPath(repo)}/pulls/${number}/reviews`,
        {
          method: 'POST',
          body: {
            commit_id: input.commitId,
            body: input.body,
            comments: input.comments.map(({ path, line, side, body }) => ({ path, line, side, body })),
          },
        },
      )
      return { id: data.id, state: data.state, htmlUrl: data.html_url }
    },

    async reviewComments(repo: RepoRef, number: number, reviewId: number): Promise<ReviewComment[]> {
      const comments = await paginate<RawReviewComment>(`${repoPath(repo)}/pulls/${number}/reviews/${reviewId}/comments`)
      return comments.map((c) => ({ id: c.id, path: c.path, line: c.line ?? null, side: c.side ?? null, body: c.body }))
    },
  }
}

export type GitHubClient = ReturnType<typeof createGitHubClient>
