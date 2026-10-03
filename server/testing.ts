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
  const { app, tokens } = createApp({ db, passphrase: PASSPHRASE, log: silentSink, ...overrides })
  return {
    app,
    db,
    tokens,
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
