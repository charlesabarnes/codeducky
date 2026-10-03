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

  constructor(status: number, code: string | null) {
    super(code ? `Server error ${status}: ${code}` : `Server error ${status}`)
    this.status = status
    this.code = code
  }
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
  if (!res.ok) throw new HttpError(res.status, json?.error ?? null)
  return json as T
}
