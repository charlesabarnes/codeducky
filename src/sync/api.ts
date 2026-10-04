export class UnauthorizedError extends Error {
  constructor() {
    super('Not signed in to the sync server')
  }
}

export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('Could not reach the sync server', { cause })
  }
}

export class HttpError extends Error {
  readonly status: number
  readonly code: string | null
  /** From the Retry-After header of a 429 or 503: how long the server asked us to wait. */
  readonly retryAfterMs: number | null

  constructor(status: number, code: string | null, retryAfterMs: number | null = null) {
    super(code ? `Server error ${status}: ${code}` : `Server error ${status}`)
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

/** Longer waits are ignored in favour of the normal retry delay. */
const MAX_RETRY_AFTER_MS = 60 * 60_000

/** Retry-After as delay-seconds or an HTTP date; null when absent, unreadable, past or implausibly long. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null
  const seconds = Number(value)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now
  return ms > 0 && ms <= MAX_RETRY_AFTER_MS ? ms : null
}

export interface ApiOptions {
  baseUrl: string
  fetch: typeof fetch
}

export async function apiRequest<T>(
  { baseUrl, fetch: fetchImpl }: ApiOptions,
  method: string,
  path: string,
  { body, token }: { body?: unknown; token?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  let res: Response
  try {
    res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    })
  } catch (error) {
    throw new NetworkError(error)
  }
  if (res.status === 401) throw new UnauthorizedError()
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok) {
    const retryAfter = res.status === 429 || res.status === 503 ? parseRetryAfter(res.headers.get('Retry-After')) : null
    throw new HttpError(res.status, json?.error ?? null, retryAfter)
  }
  return json as T
}
