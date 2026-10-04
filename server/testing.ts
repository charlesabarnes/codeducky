import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeSignIn, type SignedIn } from '../test/support/fakeSignIn'
import { createApp, type AppDeps } from './app'
import { fakeGitHubId, fakeGitHubProvider } from './auth/fakeGitHub'
import { createTokenStore } from './auth/tokens'
import { openDatabase } from './db'
import { silentSink } from './log'
import { getUserByGitHubId, upsertGitHubUser } from './users/store'

export const ADMIN_PASSPHRASE = 'correct horse battery'

/** An app over a fresh SQLite file in a temp dir, signing in through the fake GitHub; call `cleanup` when done. */
export function makeApp(overrides: Partial<AppDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codeducky-server-'))
  const db = openDatabase(join(dir, 'test.db'))
  const { app, tokens, oauth, channel } = createApp({
    db,
    provider: fakeGitHubProvider({ now: overrides.now }),
    adminPassphrase: ADMIN_PASSPHRASE,
    log: silentSink,
    ...overrides,
  })
  return {
    app,
    db,
    tokens,
    oauth,
    channel,
    cleanup: () => {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

type App = ReturnType<typeof makeApp>['app']

export function request(app: App, method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
}

export const TEST_ORIGIN = 'http://codeducky.test'

/** Sends one request to the app in process without following redirects. */
export const appSend = (app: App) => (url: string, init?: RequestInit) => Promise.resolve(app.request(url, init))

/** Signs `login` in through the whole fake GitHub flow (start, authorize, callback, exchange). */
export function signInAs(app: App, login: string, name?: string): Promise<SignedIn> {
  return fakeSignIn(appSend(app), TEST_ORIGIN, login, name)
}

/** The GitHub login `login()` signs in as. */
export const OWNER = 'owner'

/** A device session for a GitHub user, the usual principal in tests. */
export async function login(app: App, name?: string): Promise<string> {
  return (await signInAs(app, OWNER, name)).token
}

/** The user id of a GitHub login that has signed in. */
export const userIdFor = (db: Database, login: string) => getUserByGitHubId(db, fakeGitHubId(login))!.id

/** A session for the built-in admin account, through the admin passphrase. */
export async function adminLogin(app: App, name?: string): Promise<SignedIn> {
  const res = await request(app, 'POST', '/api/auth/admin/login', { passphrase: ADMIN_PASSPHRASE, name })
  if (res.status !== 200) throw new Error(`admin login failed: ${res.status}`)
  return (await res.json()) as SignedIn
}


/** Signs a GitHub user in without the GitHub round-trip: creates the user if needed and issues a device session. */
export function createUserSession(db: Database, login: string, name = 'Browser') {
  const user = upsertGitHubUser(db, { id: fakeGitHubId(login), login, name: null, avatarUrl: null })
  const { token } = createTokenStore(db).issue({ userId: user.id, name, kind: 'session' })
  return { token, user }
}

/** A fetch that answers from the app in process, for SDK clients. */
export function appFetch(app: App): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    return Promise.resolve(app.request(url, input instanceof Request ? input : init))
  }) as typeof fetch
}

/** An MCP SDK client connected to the app's /mcp endpoint with a bearer token. */
export async function mcpClient(app: App, token: string) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const client = new Client({ name: 'codeducky-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${TEST_ORIGIN}/mcp`), {
    fetch: appFetch(app),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}
