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

/** In-memory stand-in for the server's /api/auth and /api/sync, with the same validation and merge rules. */
export class FakeSyncServer {
  private rev = 0
  private readonly rows = new Map<string, ServerChange>()
  private readonly tokens = new Set<string>()
  readonly requests: SyncRequest[] = []
  /** Simulates the network being down. */
  offline = false
  /** Refuses a pushed change with this message, as server-side validation would. */
  reject: (change: WireChange) => string | null = () => null

  constructor(
    readonly passphrase = 'pass',
    private readonly pageSize = SYNC_PAGE_SIZE,
  ) {}

  records(): ServerChange[] {
    return [...this.rows.values()].sort((a, b) => a.rev - b.rev)
  }

  live(kind: string): ServerChange[] {
    return this.records().filter((c) => c.kind === kind && !c.deleted)
  }

  revokeAll(): void {
    this.tokens.clear()
  }

  handle(request: unknown): SyncResponse {
    const parsed = parseSyncRequest(request)
    if ('error' in parsed) throw new Error(parsed.error)
    this.requests.push(structuredClone(request as SyncRequest))
    const rejected: RejectedChange[] = [...parsed.rejected]
    for (const change of parsed.changes) {
      const error = this.reject(change)
      if (error) rejected.push({ kind: change.kind, id: change.id, error })
      else this.apply(change)
    }
    const since = this.records().filter((c) => c.rev > parsed.cursor)
    const page = since.slice(0, this.pageSize)
    return {
      changes: structuredClone(page),
      newCursor: page.at(-1)?.rev ?? parsed.cursor,
      more: since.length > this.pageSize,
      rejected,
    }
  }

  private apply(change: WireChange): void {
    const key = `${change.kind}:${change.id}`
    if (!wins(change, this.rows.get(key))) return
    const stored: ServerChange = { ...change, rev: ++this.rev }
    if (change.deleted) delete stored.data
    this.rows.set(key, structuredClone(stored))
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (this.offline) throw new TypeError('Failed to fetch')
    const path = new URL(String(input), 'http://fake').pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '')
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
    if (path === '/api/auth/login') {
      if (body?.passphrase !== this.passphrase) return json({ error: 'invalid_passphrase' }, 401)
      const issued = `cdb_${this.tokens.size + 1}_${Math.random().toString(36).slice(2)}`
      this.tokens.add(issued)
      return json({ token: issued, tokenId: issued })
    }
    if (!token || !this.tokens.has(token)) return json({ error: 'unauthorized' }, 401)
    if (path === '/api/auth/logout') {
      this.tokens.delete(token)
      return json({ ok: true })
    }
    if (path === '/api/sync') return json(this.handle(body))
    return json({ error: 'not_found' }, 404)
  }
}
