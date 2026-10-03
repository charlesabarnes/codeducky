import type { Context, MiddlewareHandler } from 'hono'
import { getConnInfo } from 'hono/bun'
import type { TokenInfo, TokenKind, TokenStore } from './tokens'

export interface AuthEnv {
  Variables: { principal: TokenInfo }
}

export function bearerToken(c: Context): string | null {
  const header = c.req.header('authorization')
  const match = header?.match(/^Bearer\s+(\S+)$/i)
  return match?.[1] ?? null
}

/** The proxy in front (gangway) appends the real client address last. */
export function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) return forwarded.split(',').at(-1)!.trim()
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Rejects requests without a valid bearer token, optionally limited to some token kinds. */
export function requireToken(tokens: TokenStore, kinds?: readonly TokenKind[]): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const raw = bearerToken(c)
    const principal = raw ? tokens.verify(raw) : null
    if (!principal) {
      c.header('WWW-Authenticate', 'Bearer')
      return c.json({ error: 'unauthorized' }, 401)
    }
    if (kinds && !kinds.includes(principal.kind)) return c.json({ error: 'forbidden' }, 403)
    c.set('principal', principal)
    return next()
  }
}
