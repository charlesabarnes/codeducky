import { createHash, randomBytes } from 'node:crypto'

/** Answers one request without following redirects: the real server through fetch, or a Hono app in process. */
export type Send = (url: string, init?: RequestInit) => Promise<Response>

export interface SignedIn {
  token: string
  tokenId: string
  user: { id: string; login: string; name: string | null; avatarUrl: string | null; role: 'user' | 'admin' }
}

export const newVerifier = () => randomBytes(32).toString('base64url')
export const challengeFor = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

function location(res: Response, step: string): string {
  const to = res.headers.get('location')
  if (res.status !== 302 || !to) throw new Error(`${step}: expected a redirect, got ${res.status}`)
  return to
}

/** The `name=value` pairs a response sets, ready for a Cookie header. */
const cookies = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0]!)
    .join('; ')

/**
 * Drives the fake GitHub round-trip as a browser would: start, the fake authorize page with
 * `auto=1`, then the callback with the flow cookie. Returns the `/signin/callback` fragment.
 */
export async function fakeGitHubRoundTrip(send: Send, base: string, login: string, challenge: string): Promise<URLSearchParams> {
  const start = await send(`${base}/api/auth/github/start?challenge=${challenge}`)
  const authorize = new URL(location(start, 'start'), base)
  authorize.searchParams.set('login', login)
  authorize.searchParams.set('auto', '1')
  const callback = location(await send(authorize.toString()), 'fake authorize')
  const landing = location(await send(callback, { headers: { Cookie: cookies(start) } }), 'callback')
  return new URLSearchParams(new URL(landing, base).hash.slice(1))
}

/** Signs `login` in through the fake GitHub provider and swaps the hand-off for a session token. */
export async function fakeSignIn(send: Send, base: string, login: string, name = 'Browser'): Promise<SignedIn> {
  const verifier = newVerifier()
  const fragment = await fakeGitHubRoundTrip(send, base, login, challengeFor(verifier))
  const handoff = fragment.get('handoff')
  if (!handoff) throw new Error(`sign-in failed: ${fragment.get('error') ?? 'no hand-off'}`)
  const res = await send(`${base}/api/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handoff, verifier, name }),
  })
  if (res.status !== 200) throw new Error(`exchange failed: ${res.status}`)
  return (await res.json()) as SignedIn
}

/** fetch against a real server, leaving redirects to the caller. */
export const fetchSend: Send = (url, init) => fetch(url, { ...init, redirect: 'manual' })
