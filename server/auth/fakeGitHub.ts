import { createHash } from 'node:crypto'
import { Hono, type Context } from 'hono'
import type { GitHubIdentity } from '../users/store'
import { GitHubError, type IdentityProvider } from './github'
import { escapeHtml, errorPage, page, PAGE_HEADERS } from './oauth/consent'
import { randomSecret, verifierMatches } from './pkce'

/** Where the fake authorize page lives, relative to /api/auth. */
export const FAKE_AUTHORIZE_PATH = '/fake-github/authorize'
const TTL_MS = 10 * 60_000
const MAX_PENDING = 1000
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

/** A stable fake GitHub id per login, so the same login is the same user across sign-ins. */
export const fakeGitHubId = (login: string) => createHash('sha256').update(login.toLowerCase()).digest().readUInt32BE(0)

interface Pending {
  redirectUri: string
  challenge: string
  expiresAt: number
}

interface IssuedCode extends Pending {
  identity: GitHubIdentity
}

function signInForm(state: string, error?: string): string {
  return page(
    'Fake GitHub sign-in',
    `<h1>Sign in as</h1>
<p class="muted">This server uses a fake GitHub for development and tests. Anyone can sign in as anyone.</p>
<form method="post">
<input type="hidden" name="state" value="${escapeHtml(state)}">
<label>GitHub login<input name="login" autocomplete="username" required autofocus pattern="[A-Za-z0-9][A-Za-z0-9\\-]{0,38}"></label>
<label>Numeric id (optional)<input name="id" inputmode="numeric" pattern="[0-9]{1,15}"></label>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<div class="row"><button class="primary" type="submit" name="decision" value="approve">Sign in</button>
<button class="secondary" type="submit" name="decision" value="deny" formnovalidate>Cancel</button></div>
</form>`,
  )
}

/**
 * Stands in for GitHub in development, tests and throwaway previews: a "sign in as" form, or
 * `?login=alice&auto=1` to skip it. Codes are single use and bound to the PKCE challenge, as on GitHub.
 */
export function fakeGitHubProvider({ now = Date.now }: { now?: () => number } = {}): IdentityProvider {
  const pending = new Map<string, Pending>()
  const codes = new Map<string, IssuedCode>()

  const prune = () => {
    for (const map of [pending, codes]) {
      for (const [key, value] of map) if (value.expiresAt <= now()) map.delete(key)
      while (map.size >= MAX_PENDING) map.delete(map.keys().next().value!)
    }
  }

  const redirect = (c: Context, base: string, values: Record<string, string>) => {
    const url = new URL(base)
    for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value)
    return c.redirect(url.toString(), 302)
  }

  function complete(c: Context, input: { state?: string; login?: string; id?: string; deny?: boolean }) {
    const flow = input.state ? pending.get(input.state) : undefined
    if (!flow || flow.expiresAt <= now()) return c.body(errorPage('Unknown or expired sign-in. Start again from Code Ducky.'), 400, PAGE_HEADERS)
    const state = input.state!
    if (input.deny) {
      pending.delete(state)
      return redirect(c, flow.redirectUri, { error: 'access_denied', state })
    }
    const login = input.login?.trim() ?? ''
    if (!LOGIN.test(login)) return c.body(signInForm(state, 'Enter a GitHub login: letters, digits and dashes.'), 400, PAGE_HEADERS)
    const id = input.id?.trim() ? Number(input.id) : fakeGitHubId(login)
    if (!Number.isSafeInteger(id) || id <= 0) return c.body(signInForm(state, 'The id must be a positive whole number.'), 400, PAGE_HEADERS)
    pending.delete(state)
    prune()
    const code = `fake_${randomSecret()}`
    codes.set(code, { ...flow, expiresAt: now() + TTL_MS, identity: { id, login, name: null, avatarUrl: null } })
    return redirect(c, flow.redirectUri, { code, state })
  }

  const routes = new Hono()
  routes.get(FAKE_AUTHORIZE_PATH, (c) => {
    const query = c.req.query()
    if (query.auto === '1') return complete(c, { ...query, deny: query.deny === '1' })
    const flow = query.state ? pending.get(query.state) : undefined
    if (!flow || flow.expiresAt <= now()) return c.body(errorPage('Unknown or expired sign-in. Start again from Code Ducky.'), 400, PAGE_HEADERS)
    return c.body(signInForm(query.state!), 200, PAGE_HEADERS)
  })
  routes.post(FAKE_AUTHORIZE_PATH, async (c) => {
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
    const field = (name: string) => (typeof body[name] === 'string' ? (body[name] as string) : undefined)
    return complete(c, { state: field('state'), login: field('login'), id: field('id'), deny: field('decision') === 'deny' })
  })

  return {
    authorizeUrl({ state, challenge, redirectUri }) {
      prune()
      pending.set(state, { redirectUri, challenge, expiresAt: now() + TTL_MS })
      const url = new URL(`/api/auth${FAKE_AUTHORIZE_PATH}`, redirectUri)
      url.searchParams.set('state', state)
      return url.toString()
    },

    async exchange({ code, verifier, redirectUri }) {
      const issued = codes.get(code)
      codes.delete(code)
      if (!issued || issued.expiresAt <= now() || issued.redirectUri !== redirectUri || !verifierMatches(verifier, issued.challenge)) {
        throw new GitHubError('bad_verification_code')
      }
      return issued.identity
    },

    routes,
  }
}
