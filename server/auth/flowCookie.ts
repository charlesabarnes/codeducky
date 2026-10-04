import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { publicOrigin } from '../origin'
import { FLOW_TTL_MS } from './flows'

/** Where GitHub (or the fake) sends the browser back, for both PWA sign-in and MCP consent. */
export const CALLBACK_PATH = '/api/auth/github/callback'
const COOKIE_PATH = '/api/auth'

/**
 * The short-lived cookie that ties a GitHub round-trip to the browser that started it. It is
 * scoped to /api/auth, so it reaches the callback but nothing else.
 */
export function flowCookie(publicUrl?: string) {
  const secure = (c: Context) => publicOrigin(c, publicUrl).startsWith('https:')
  /** `__Host-` would need Path=/; `__Secure-` keeps the cookie on /api/auth only. */
  const name = (c: Context) => (secure(c) ? '__Secure-rd_flow' : 'rd_flow')

  return {
    set(c: Context, flowId: string) {
      setCookie(c, name(c), flowId, { path: COOKIE_PATH, httpOnly: true, sameSite: 'Lax', secure: secure(c), maxAge: FLOW_TTL_MS / 1000 })
    },
    read: (c: Context) => getCookie(c, name(c)),
    clear(c: Context) {
      deleteCookie(c, name(c), { path: COOKIE_PATH, secure: secure(c), httpOnly: true, sameSite: 'Lax' })
    },
    callbackUrl: (c: Context) => `${publicOrigin(c, publicUrl)}${CALLBACK_PATH}`,
  }
}

export type FlowCookie = ReturnType<typeof flowCookie>
