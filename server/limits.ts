import type { Context, Env, MiddlewareHandler } from 'hono'
import type { AuthEnv } from './auth/middleware'

export interface RateLimiterOptions {
  /** Requests allowed in a burst. */
  capacity: number
  /** Tokens added back per second, up to `capacity`. */
  refillPerSec: number
  now?: () => number
  /** Past this many keys, buckets that have refilled completely are dropped. */
  maxKeys?: number
}

interface Bucket {
  tokens: number
  at: number
}

/** A token bucket per key: each request takes one token, and tokens refill at a steady rate. */
export function createRateLimiter({ capacity, refillPerSec, now = Date.now, maxKeys = 10_000 }: RateLimiterOptions) {
  const buckets = new Map<string, Bucket>()

  const refill = (bucket: Bucket) => {
    const at = now()
    bucket.tokens = Math.min(capacity, bucket.tokens + ((at - bucket.at) / 1000) * refillPerSec)
    bucket.at = at
  }

  const prune = () => {
    for (const [key, bucket] of buckets) {
      refill(bucket)
      if (bucket.tokens >= capacity) buckets.delete(key)
    }
  }

  return {
    /** Takes a token for `key`. Returns null when the request may go ahead, or the seconds to wait. */
    take(key: string): number | null {
      let bucket = buckets.get(key)
      if (bucket) refill(bucket)
      else {
        if (buckets.size >= maxKeys) prune()
        bucket = { tokens: capacity, at: now() }
        buckets.set(key, bucket)
      }
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1
        return null
      }
      return Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerSec))
    },
  }
}

export type RateLimiter = ReturnType<typeof createRateLimiter>

export function tooManyRequests(c: Context, retryAfter: number) {
  c.header('Retry-After', String(retryAfter))
  return c.json({ error: 'rate_limited' }, 429)
}

/** Refuses the request with 429 and Retry-After once the key's bucket is empty. */
export function rateLimit<E extends Env>(limiter: RateLimiter, keyFn: (c: Context<E>) => string): MiddlewareHandler<E> {
  return async (c, next) => {
    const retryAfter = limiter.take(keyFn(c))
    if (retryAfter !== null) return tooManyRequests(c, retryAfter)
    return next()
  }
}

/** Keys a limiter by the signed-in user; mount after `requireToken`. */
export const perUser = (c: Context<AuthEnv>) => c.get('principal').userId

export interface RateSpec {
  /** Requests allowed per window. */
  limit: number
  windowSec: number
  /** Requests allowed back to back; the rest are spread over the window. */
  burst: number
}

export type RateLimitName = 'sync' | 'mcp' | 'gate' | 'channelTasks' | 'githubStart' | 'newAccounts' | 'push'
export type RateLimits = Record<RateLimitName, RateSpec>

export const DEFAULT_RATE_LIMITS: RateLimits = {
  sync: { limit: 120, windowSec: 60, burst: 30 },
  mcp: { limit: 300, windowSec: 60, burst: 300 },
  gate: { limit: 120, windowSec: 60, burst: 120 },
  channelTasks: { limit: 30, windowSec: 60, burst: 30 },
  githubStart: { limit: 20, windowSec: 600, burst: 20 },
  newAccounts: { limit: 30, windowSec: 3600, burst: 30 },
  push: { limit: 60, windowSec: 3600, burst: 20 },
}

const RATE_ENV: Record<RateLimitName, string> = {
  sync: 'CODEDUCKY_RATE_SYNC',
  mcp: 'CODEDUCKY_RATE_MCP',
  gate: 'CODEDUCKY_RATE_GATE',
  channelTasks: 'CODEDUCKY_RATE_CHANNEL_TASKS',
  githubStart: 'CODEDUCKY_RATE_GITHUB_START',
  newAccounts: 'CODEDUCKY_RATE_NEW_ACCOUNTS',
  push: 'CODEDUCKY_RATE_PUSH',
}

/** Reads an optional positive integer from the environment. */
export function positiveInt(env: Record<string, string | undefined>, name: string): number | undefined {
  const raw = env[name]?.trim()
  if (!raw) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

/** Each CODEDUCKY_RATE_* variable sets that limit's requests per window; the burst scales with it. */
export function loadRateLimits(env: Record<string, string | undefined>): RateLimits {
  const limits = { ...DEFAULT_RATE_LIMITS }
  for (const name of Object.keys(RATE_ENV) as RateLimitName[]) {
    const limit = positiveInt(env, RATE_ENV[name])
    if (limit === undefined) continue
    const spec = DEFAULT_RATE_LIMITS[name]
    limits[name] = { ...spec, limit, burst: Math.max(1, Math.round((spec.burst * limit) / spec.limit)) }
  }
  return limits
}

export type RateLimiters = Record<RateLimitName, RateLimiter>

export function createRateLimiters(limits: RateLimits = DEFAULT_RATE_LIMITS, now?: () => number): RateLimiters {
  const limiters = {} as RateLimiters
  for (const name of Object.keys(limits) as RateLimitName[]) {
    const { limit, windowSec, burst } = limits[name]
    limiters[name] = createRateLimiter({ capacity: burst, refillPerSec: limit / windowSec, now })
  }
  return limiters
}
