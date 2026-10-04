import type { Hono } from 'hono'
import { silentSink, type LogSink } from '../log'
import type { GitHubIdentity } from '../users/store'

export interface IdentityProvider {
  authorizeUrl(p: { state: string; challenge: string; redirectUri: string }): string
  exchange(p: { code: string; verifier: string; redirectUri: string }): Promise<GitHubIdentity>
  /** Extra routes under /api/auth, mounted only for providers that serve their own pages (the fake). */
  routes?: Hono
}

/** Anything that goes wrong talking to GitHub; the message never includes a token. */
export class GitHubError extends Error {}

export interface GitHubProviderOptions {
  clientId: string
  clientSecret: string
  fetch?: typeof fetch
  timeoutMs?: number
  /** Where a failed token revoke is reported; sign-in goes ahead regardless. */
  log?: LogSink
}

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
const TOKEN_URL = 'https://github.com/login/oauth/access_token'
const API = 'https://api.github.com'
const USER_AGENT = 'codeducky'

interface GitHubUser {
  id?: unknown
  login?: unknown
  name?: unknown
  avatar_url?: unknown
}

function toIdentity(user: GitHubUser): GitHubIdentity {
  if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || typeof user.login !== 'string' || !user.login) {
    throw new GitHubError('GitHub returned an unexpected user')
  }
  return {
    id: user.id,
    login: user.login,
    name: typeof user.name === 'string' && user.name ? user.name : null,
    avatarUrl: typeof user.avatar_url === 'string' && user.avatar_url ? user.avatar_url : null,
  }
}

/**
 * Sign-in through a GitHub OAuth App with an empty scope: enough to read who signed in. The
 * access token is used once for /user, then revoked, and never stored or logged.
 */
export function githubProvider({
  clientId,
  clientSecret,
  fetch: fetchImpl = fetch,
  timeoutMs = 10_000,
  log = silentSink,
}: GitHubProviderOptions): IdentityProvider {
  const call = async (url: string, init: RequestInit): Promise<Response> => {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch {
      throw new GitHubError(`Could not reach GitHub (${new URL(url).pathname})`)
    }
  }

  async function accessToken(code: string, verifier: string, redirectUri: string): Promise<string> {
    const res = await call(TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, code_verifier: verifier }),
    })
    const body = (await res.json().catch(() => null)) as { access_token?: unknown; error?: unknown } | null
    if (!res.ok || typeof body?.access_token !== 'string') {
      throw new GitHubError(`GitHub refused the code: ${typeof body?.error === 'string' ? body.error : res.status}`)
    }
    return body.access_token
  }

  async function user(token: string): Promise<GitHubIdentity> {
    const res = await call(`${API}/user`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT },
    })
    if (!res.ok) throw new GitHubError(`GitHub /user answered ${res.status}`)
    return toIdentity((await res.json().catch(() => ({}))) as GitHubUser)
  }

  /** Best effort, not retried: the token has no scope and expires on its own, but a failure is logged. */
  async function revoke(token: string): Promise<void> {
    const res = await call(`${API}/applications/${encodeURIComponent(clientId)}/token`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ access_token: token }),
    }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    if (typeof res === 'string' || !res.ok) {
      log({ level: 'warn', event: 'github_revoke_failed', error: typeof res === 'string' ? res : `GitHub answered ${res.status}` })
    }
  }

  return {
    authorizeUrl({ state, challenge, redirectUri }) {
      const url = new URL(AUTHORIZE_URL)
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        scope: '',
        allow_signup: 'true',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString()
      return url.toString()
    },

    async exchange({ code, verifier, redirectUri }) {
      const token = await accessToken(code, verifier, redirectUri)
      try {
        return await user(token)
      } finally {
        await revoke(token).catch(() => undefined)
      }
    },
  }
}
