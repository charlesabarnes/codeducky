import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest()

/** Hashing first makes both sides the same length, so the comparison runs in constant time. */
export function passphraseMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false
  return timingSafeEqual(sha256(given), sha256(expected))
}

export const TOKEN_PREFIX = 'skb_'

export const newToken = () => `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`

export const hashToken = (token: string) => sha256(token).toString('hex')

export interface RateLimitOptions {
  /** Failures allowed per client within the window. */
  perClient: number
  /** Failures allowed across all clients within the window (a spoofed or rotating client address). */
  global: number
  windowMs: number
  now?: () => number
}

interface Bucket {
  count: number
  resetAt: number
}

/** Counts failed sign-ins; once a limit is hit, further attempts wait until the window ends. */
export function createFailureLimiter({ perClient, global, windowMs, now = Date.now }: RateLimitOptions) {
  const clients = new Map<string, Bucket>()
  let all: Bucket = { count: 0, resetAt: 0 }

  const live = (bucket: Bucket | undefined) => (bucket && bucket.resetAt > now() ? bucket : undefined)
  const wait = (bucket: Bucket) => Math.max(1, Math.ceil((bucket.resetAt - now()) / 1000))

  return {
    /** Seconds to wait, or null when the client may try. */
    retryAfter(client: string): number | null {
      const own = live(clients.get(client))
      if (own && own.count >= perClient) return wait(own)
      const shared = live(all)
      if (shared && shared.count >= global) return wait(shared)
      return null
    },
    fail(client: string): void {
      if (clients.size > 10_000) for (const [key, bucket] of clients) if (!live(bucket)) clients.delete(key)
      const own = live(clients.get(client))
      if (own) own.count++
      else clients.set(client, { count: 1, resetAt: now() + windowMs })
      if (live(all)) all.count++
      else all = { count: 1, resetAt: now() + windowMs }
    },
    succeed(client: string): void {
      clients.delete(client)
    },
  }
}

export type FailureLimiter = ReturnType<typeof createFailureLimiter>
