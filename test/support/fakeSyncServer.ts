import {
  parseSyncRequest,
  SYNC_PAGE_SIZE,
  wins,
  type RejectedChange,
  type ServerChange,
  type SyncRequest,
  type SyncResponse,
  type WireChange,
} from '../../shared/sync'
import type { SyncController } from '../../src/sync/controller'
import type { SessionUser } from '../../src/sync/meta'
import { challengeOf } from '../../src/sync/pkce'

interface UserStore {
  rev: number
  rows: Map<string, ServerChange>
}

/**
 * In-memory stand-in for the server's /api/auth, /api/account and /api/sync, with the same
 * validation and merge rules. Each account has its own records; GitHub is reduced to `handoff`.
 */
export class FakeSyncServer {
  private readonly users = new Map<string, SessionUser>()
  private readonly stores = new Map<string, UserStore>()
  private readonly tokens = new Map<string, SessionUser>()
  private readonly handoffs = new Map<string, { user: SessionUser; challenge: string }>()
  readonly requests: SyncRequest[] = []
  /** Simulates the network being down. */
  offline = false
  /** Refuses a pushed change with this message, as server-side validation would. */
  reject: (change: WireChange) => string | null = () => null
  adminPassphrase = 'pass'
  /** Logins whose accounts the admin disabled. */
  readonly disabled = new Set<string>()
  quota = { records: 20_000, bytes: 50 * 1024 * 1024 }

  constructor(private readonly pageSize = SYNC_PAGE_SIZE) {}

  user(login: string): SessionUser {
    let user = this.users.get(login)
    if (!user) {
      user = login === 'admin'
        ? { id: 'admin', login, name: null, avatarUrl: null, role: 'admin' }
        : { id: `user-${login}`, login, name: null, avatarUrl: `https://avatars.example/${login}`, role: 'user' }
      this.users.set(login, user)
    }
    return user
  }

  /** What GitHub's callback does: a one-time code bound to the challenge the browser started with. */
  handoff(login: string, challenge: string): string {
    const code = `handoff_${this.handoffs.size + 1}_${Math.random().toString(36).slice(2)}`
    this.handoffs.set(code, { user: this.user(login), challenge })
    return code
  }

  private store(login: string): UserStore {
    const id = this.user(login).id
    let store = this.stores.get(id)
    if (!store) this.stores.set(id, (store = { rev: 0, rows: new Map() }))
    return store
  }

  records(login = 'me'): ServerChange[] {
    return [...this.store(login).rows.values()].sort((a, b) => a.rev - b.rev)
  }

  live(kind: string, login = 'me'): ServerChange[] {
    return this.records(login).filter((c) => c.kind === kind && !c.deleted)
  }

  revokeAll(): void {
    this.tokens.clear()
  }

  sessionCount(login: string): number {
    return [...this.tokens.values()].filter((user) => user.login === login).length
  }

  handle(request: unknown, login = 'me'): SyncResponse {
    const parsed = parseSyncRequest(request)
    if ('error' in parsed) throw new Error(parsed.error)
    this.requests.push(structuredClone(request as SyncRequest))
    const rejected: RejectedChange[] = [...parsed.rejected]
    for (const change of parsed.changes) {
      const error = this.reject(change)
      if (error) rejected.push({ kind: change.kind, id: change.id, error })
      else this.apply(login, change)
    }
    const since = this.records(login).filter((c) => c.rev > parsed.cursor)
    const page = since.slice(0, this.pageSize)
    return {
      changes: structuredClone(page),
      newCursor: page.at(-1)?.rev ?? parsed.cursor,
      more: since.length > this.pageSize,
      rejected,
    }
  }

  private apply(login: string, change: WireChange): void {
    const store = this.store(login)
    const key = `${change.kind}:${change.id}`
    if (!wins(change, store.rows.get(key))) return
    const stored: ServerChange = { ...change, rev: ++store.rev }
    if (change.deleted) delete stored.data
    store.rows.set(key, structuredClone(stored))
  }

  private issue(user: SessionUser) {
    const token = `cdb_${this.tokens.size + 1}_${Math.random().toString(36).slice(2)}`
    this.tokens.set(token, user)
    return { token, tokenId: token, user }
  }

  private usage(login: string) {
    const rows = this.records(login)
    return { records: rows.length, bytes: rows.reduce((sum, row) => sum + (row.data ? JSON.stringify(row.data).length : 0), 0) }
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (this.offline) throw new TypeError('Failed to fetch')
    const path = new URL(String(input), 'http://fake').pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '')
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
    if (path === '/api/auth/exchange') {
      const handoff = this.handoffs.get(body?.handoff)
      this.handoffs.delete(body?.handoff)
      if (!handoff || (await challengeOf(String(body?.verifier))) !== handoff.challenge) return json({ error: 'invalid_handoff' }, 401)
      if (this.disabled.has(handoff.user.login)) return json({ error: 'account_disabled' }, 403)
      return json(this.issue(handoff.user))
    }
    if (path === '/api/auth/admin/login') {
      if (body?.passphrase !== this.adminPassphrase) return json({ error: 'invalid_passphrase' }, 401)
      return json(this.issue(this.user('admin')))
    }
    const user = token ? this.tokens.get(token) : undefined
    if (!token || !user) return json({ error: 'unauthorized' }, 401)
    if (path === '/api/auth/session') {
      return json({ tokenId: token, name: 'Browser', kind: 'session', user, usage: this.usage(user.login), quota: this.quota })
    }
    if (path === '/api/auth/logout') {
      this.tokens.delete(token)
      return json({ ok: true })
    }
    if (path === '/api/account' && method === 'DELETE') {
      if (body?.confirm !== user.login) return json({ error: 'confirm_mismatch' }, 400)
      this.stores.delete(user.id)
      for (const [issued, owner] of this.tokens) if (owner.id === user.id) this.tokens.delete(issued)
      return json({ ok: true })
    }
    if (path === '/api/sync') return json(this.handle(body, user.login))
    return json({ error: 'not_found' }, 404)
  }
}

/** One browser tab's view of the outside world: the fake server's fetch, its own sessionStorage, and the pages it left for. */
export function fakeBrowser(server: FakeSyncServer) {
  const stored = new Map<string, string>()
  const visited: string[] = []
  return {
    fetch: server.fetch,
    navigate: (url: string) => void visited.push(url),
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    },
    visited,
  }
}

export type FakeBrowser = ReturnType<typeof fakeBrowser>

/** Runs a GitHub sign-in as the browser would: start, GitHub and its callback, then the exchange. */
export async function signInWithGitHub(controller: SyncController, browser: FakeBrowser, server: FakeSyncServer, login = 'me', name = 'Browser') {
  await controller.beginGitHubSignIn(name)
  const challenge = new URL(browser.visited.at(-1)!, 'http://fake').searchParams.get('challenge')!
  return controller.completeSignIn(server.handoff(login, challenge))
}
