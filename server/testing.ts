import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, type AppDeps } from './app'
import { openDatabase } from './db'
import { silentSink } from './log'

export const PASSPHRASE = 'correct horse battery'

/** An app over a fresh SQLite file in a temp dir; call `cleanup` when done. */
export function makeApp(overrides: Partial<AppDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'skelbert-server-'))
  const db = openDatabase(join(dir, 'test.db'))
  const { app, tokens, channel } = createApp({ db, passphrase: PASSPHRASE, log: silentSink, ...overrides })
  return {
    app,
    db,
    tokens,
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

export async function login(app: App, name?: string): Promise<string> {
  const res = await request(app, 'POST', '/api/auth/login', { passphrase: PASSPHRASE, name })
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`)
  return ((await res.json()) as { token: string }).token
}

export const TEST_ORIGIN = 'http://skelbert.test'

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
  const client = new Client({ name: 'skelbert-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${TEST_ORIGIN}/mcp`), {
    fetch: appFetch(app),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}
