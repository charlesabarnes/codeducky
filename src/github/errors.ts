export type GitHubErrorKind =
  | 'bad-token'
  | 'forbidden'
  | 'not-found'
  | 'rate-limited'
  | 'invalid'
  | 'server'
  | 'network'

interface ErrorBody {
  message?: string
  errors?: (string | { message?: string; code?: string; field?: string })[]
}

export class GitHubError extends Error {
  readonly kind: GitHubErrorKind
  readonly status: number
  readonly resetAt: Date | null

  constructor(kind: GitHubErrorKind, status: number, message: string, resetAt: Date | null = null) {
    super(message)
    this.name = 'GitHubError'
    this.kind = kind
    this.status = status
    this.resetAt = resetAt
  }
}

export const isGitHubError = (error: unknown, kind?: GitHubErrorKind): error is GitHubError =>
  error instanceof GitHubError && (kind === undefined || error.kind === kind)

function detail(body: ErrorBody | null): string {
  if (!body) return ''
  const parts = [body.message, ...(body.errors ?? []).map((e) => (typeof e === 'string' ? e : (e.message ?? e.code)))]
  const text = parts.filter(Boolean).join('; ')
  return text ? ` GitHub said: ${text}` : ''
}

function rateLimitReset(headers: Headers): Date | null {
  const retryAfter = headers.get('retry-after')
  if (retryAfter) return new Date(Date.now() + Number(retryAfter) * 1000)
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset'))
    if (reset) return new Date(reset * 1000)
  }
  return null
}

export function errorFromResponse(status: number, headers: Headers, body: ErrorBody | null): GitHubError {
  const resetAt = rateLimitReset(headers)
  if ((status === 403 || status === 429) && resetAt) {
    return new GitHubError(
      'rate-limited',
      status,
      `GitHub rate limit reached. Try again after ${resetAt.toLocaleTimeString()}.`,
      resetAt,
    )
  }
  switch (status) {
    case 401:
      return new GitHubError(
        'bad-token',
        status,
        'GitHub rejected the token (401). Check the personal access token in Settings: it may be wrong, expired or revoked.',
      )
    case 403:
      return new GitHubError(
        'forbidden',
        status,
        'GitHub refused access (403). The token is missing a permission for this repository ' +
          '(fine-grained tokens need Contents: read and Pull requests: read and write).' +
          detail(body),
      )
    case 404:
      return new GitHubError(
        'not-found',
        status,
        'Not found on GitHub (404). The repository, branch or pull request does not exist, ' +
          'or the token cannot see it (a fine-grained token must include this repository).',
      )
    case 409:
    case 422:
      return new GitHubError('invalid', status, `GitHub rejected the request (${status}).${detail(body)}`)
    default:
      return new GitHubError(
        status >= 500 ? 'server' : 'invalid',
        status,
        `GitHub returned an error (${status}).${detail(body)}`,
      )
  }
}

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
