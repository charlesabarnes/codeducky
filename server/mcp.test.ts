import { afterEach, describe, expect, it } from 'bun:test'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { pairId, type SyncResponse, type WireChange } from '../shared/sync'
import { readRecord } from './sync'
import { login, makeApp, mcpClient, request, TEST_ORIGIN } from './testing'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

const REPO = 'gh:charlesabarnes/invoice-service'
const anchor = (line: number, text: string) => ({ line, side: 'new', text, before: ['a', 'b'], after: ['c'] })

const record = (kind: WireChange['kind'], id: string, data: Record<string, unknown>): WireChange => ({
  kind,
  id,
  changedAt: 100,
  deleted: false,
  data,
})

const note = (id: string, sessionId: string, extra: Record<string, unknown> = {}) =>
  record('notes', id, {
    sessionId,
    path: 'src/invoice.ts',
    anchor: anchor(12, 'const total = sum(items)'),
    body: `Body of ${id}`,
    severity: 'issue',
    status: 'open',
    source: 'me',
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  })

const SEED: WireChange[] = [
  record('repos', REPO, { owner: 'charlesabarnes', name: 'invoice-service', folderName: 'invoice-service', baseBranch: 'main', lastOpenedAt: 5, checklistIds: [] }),
  record('sessions', 's-old', { repoId: REPO, branch: 'feature/tax', headSha: 'h0', baseSha: 'b0', baseSource: 'local', startedAt: 1, status: 'archived' }),
  record('sessions', 's1', { repoId: REPO, branch: 'feature/tax', headSha: 'h1', baseSha: 'b1', baseSource: 'local', startedAt: 2, status: 'active' }),
  record('sessions', 's2', { repoId: REPO, branch: 'main', headSha: 'h2', baseSha: 'b2', baseSource: 'local', startedAt: 3, status: 'active' }),
  note('n-archived', 's-old'),
  note('n1', 's1'),
  note('n2', 's1', { path: 'src/tax/rates.ts', severity: 'nit', anchor: anchor(3, 'export const RATE = 0.2') }),
  note('n3', 's1', { status: 'resolved' }),
  note('n4', 's1', { status: 'suggested', source: 'claude' }),
  note('n5', 's2', { severity: 'blocker' }),
  record('checklists', 'cl-global', { scope: 'global', title: 'Before push', items: [{ id: 'i1', text: 'Tests pass' }, { id: 'i2', text: 'No logs' }] }),
  record('checklists', 'cl-repo', { scope: REPO, title: 'Invoices', items: [{ id: 'i3', text: 'Rounding checked' }] }),
  record('checklists', 'cl-other', { scope: 'gh:x/y', title: 'Other repo', items: [{ id: 'i9', text: 'Nope' }] }),
  record('checklistState', pairId('s1', 'i1'), { sessionId: 's1', itemId: 'i1', checked: true }),
]

async function setup() {
  const made = makeApp()
  cleanups.push(made.cleanup)
  const session = await login(made.app)
  const pushed = await request(made.app, 'POST', '/api/sync', { cursor: 0, changes: SEED }, session)
  expect(((await pushed.json()) as SyncResponse).rejected).toEqual([])
  const minted = await request(made.app, 'POST', '/api/auth/tokens', { name: 'Claude Code' }, session)
  const { token } = (await minted.json()) as { token: string }
  const client = await mcpClient(made.app, token)
  cleanups.push(() => void client.close())
  const call = async <T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult
    const text = (result.content[0] as { text: string }).text
    if (result.isError) return { error: text } as T & { error?: string }
    return JSON.parse(text) as T & { error?: string }
  }
  return { ...made, session, token, client, call }
}

interface NoteOut {
  id: string
  path: string
  line: number
  severity: string
  status: string
  source: string
  anchor: { text: string; before: string[]; after: string[] }
  anchorLost: boolean
  resolution?: { by: string; text: string }
}

describe('mcp tools', () => {
  it('lists every tool with an input schema', async () => {
    const { client } = await setup()
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'add_note',
      'check_item',
      'get_checklist',
      'get_note',
      'get_review_context',
      'list_notes',
      'list_repos',
      'list_review_requests',
      'list_sessions',
      'resolve_note',
    ])
    for (const tool of tools) {
      expect(tool.description!.length).toBeGreaterThan(20)
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  it('list_repos shows branches with their current session', async () => {
    const { call } = await setup()
    const { repos } = await call<{ repos: { repo: string; branches: { branch: string; session: string; openNotes: number }[] }[] }>('list_repos')
    expect(repos).toHaveLength(1)
    expect(repos[0]!.repo).toBe('charlesabarnes/invoice-service')
    expect(repos[0]!.branches.sort((a, b) => a.branch.localeCompare(b.branch))).toEqual([
      { branch: 'feature/tax', session: 's1', openNotes: 2 },
      { branch: 'main', session: 's2', openNotes: 1 },
    ])
  })

  it('list_sessions finds the current session for owner/name@branch', async () => {
    const { call } = await setup()
    const { sessions } = await call<{ sessions: { id: string; current: boolean; notes: Record<string, number> }[] }>('list_sessions', {
      repo: 'CharlesABarnes/Invoice-Service',
      branch: 'feature/tax',
    })
    expect(sessions.map((s) => [s.id, s.current])).toEqual([
      ['s1', true],
      ['s-old', false],
    ])
    expect(sessions[0]!.notes).toEqual({ open: 2, suggested: 1, resolved: 1, dismissed: 0 })
    expect((await call('list_sessions', { repo: 'nobody/nothing' })).error).toContain('Known repos: charlesabarnes/invoice-service')
  })

  it('list_notes defaults to open notes in the current session and filters', async () => {
    const { call } = await setup()
    type Out = { total: number; notes: NoteOut[] }
    const branch = await call<Out>('list_notes', { repo: 'charlesabarnes/invoice-service', branch: 'feature/tax' })
    expect(branch.notes.map((n) => n.id)).toEqual(['n1', 'n2'])
    expect(branch.notes[0]).toMatchObject({
      path: 'src/invoice.ts',
      line: 12,
      side: 'new',
      severity: 'issue',
      body: 'Body of n1',
      anchor: { text: 'const total = sum(items)', before: ['a', 'b'], after: ['c'] },
      anchorLost: false,
    })
    expect((await call<Out>('list_notes')).notes.map((n) => n.id).sort()).toEqual(['n1', 'n2', 'n5'])
    expect((await call<Out>('list_notes', { session: 's1', path: 'src/tax' })).notes.map((n) => n.id)).toEqual(['n2'])
    expect((await call<Out>('list_notes', { session: 's1', severity: 'nit' })).notes.map((n) => n.id)).toEqual(['n2'])
    expect((await call<Out>('list_notes', { session: 's1', status: 'suggested', source: 'claude' })).notes.map((n) => n.id)).toEqual(['n4'])
    expect((await call<Out>('list_notes', { session: 's1', status: 'all' })).total).toBe(4)
    const all = await call<Out>('list_notes', { repo: 'charlesabarnes/invoice-service', branch: 'feature/tax', allSessions: true })
    expect(all.notes.map((n) => n.id).sort()).toEqual(['n-archived', 'n1', 'n2'])
  })

  it('get_note returns a note or an error', async () => {
    const { call } = await setup()
    expect(await call('get_note', { id: 'n2' })).toMatchObject({ id: 'n2', path: 'src/tax/rates.ts', repo: 'charlesabarnes/invoice-service', branch: 'feature/tax' })
    expect((await call('get_note', { id: 'missing' })).error).toContain('No note with id missing')
  })

  it('resolve_note stores the reply as a synced resolution', async () => {
    const { call, db, app, session } = await setup()
    const out = await call<{ resolved: NoteOut }>('resolve_note', { id: 'n1', reply: 'Fixed: totals now round per line.' })
    expect(out.resolved).toMatchObject({ status: 'resolved', resolution: { by: 'mcp:Claude Code', text: 'Fixed: totals now round per line.' } })
    const stored = readRecord(db, 'notes', 'n1')!
    expect(stored.data).toMatchObject({ status: 'resolved', resolution: { by: 'mcp:Claude Code' } })

    const feed = (await (await request(app, 'POST', '/api/sync', { cursor: SEED.length, changes: [] }, session)).json()) as SyncResponse
    expect(feed.changes.map((c) => c.id)).toEqual(['n1'])
    // A stale device edit cannot overwrite the server's write.
    const stale = { ...note('n1', 's1'), changedAt: 101 }
    await request(app, 'POST', '/api/sync', { cursor: 0, changes: [stale] }, session)
    expect(readRecord(db, 'notes', 'n1')!.data).toMatchObject({ status: 'resolved' })
  })

  it('add_note creates a suggested mcp note, with or without anchor text', async () => {
    const { call, db } = await setup()
    const added = await call<{ added: NoteOut & { session: string } }>('add_note', {
      repo: 'charlesabarnes/invoice-service',
      branch: 'feature/tax',
      path: './src/tax/rates.ts',
      line: 7,
      severity: 'issue',
      title: 'Rate is hard-coded',
      body: 'Load the VAT rate from config.',
      lineText: 'const vat = 0.2',
      before: ['// rates'],
      after: ['export { vat }'],
    })
    expect(added.added).toMatchObject({
      session: 's1',
      path: 'src/tax/rates.ts',
      status: 'suggested',
      source: 'mcp',
      anchor: { text: 'const vat = 0.2', before: ['// rates'], after: ['export { vat }'] },
    })
    const stored = readRecord(db, 'notes', added.added.id)!.data!
    expect(stored).toMatchObject({ title: 'Rate is hard-coded', sessionId: 's1', anchor: { line: 7, side: 'new' } })

    const minimal = await call<{ added: NoteOut }>('add_note', { session: 's2', path: 'README.md', line: 1, body: 'Mention the API.' })
    expect(minimal.added).toMatchObject({ severity: 'suggestion', anchor: { text: '', before: [], after: [] } })
    expect((await call('add_note', { repo: 'charlesabarnes/invoice-service', branch: 'nope', path: 'a', line: 1, body: 'x' })).error).toContain(
      'Branches with sessions: feature/tax, main',
    )
    expect((await call('add_note', { path: 'a', line: 1, body: 'x' })).error).toContain('Give a session id, or repo with branch or pr')
  })

  it('add_note takes an end line for a note on several lines, and the read tools show the range', async () => {
    const { call, db } = await setup()
    const target = { repo: 'charlesabarnes/invoice-service', branch: 'feature/tax', path: 'src/tax/rates.ts', body: 'Extract a helper.' }
    const added = await call<{ added: NoteOut & { endLine?: number; lines?: string } }>('add_note', {
      ...target,
      line: 7,
      endLine: 9,
      lineText: 'const vat = 0.2\nconst reduced = 0.05\nconst zero = 0\n',
      before: ['// rates'],
      after: ['export { vat }'],
    })
    expect(added.added).toMatchObject({
      line: 7,
      endLine: 9,
      lines: '7–9',
      anchor: { text: 'const vat = 0.2', rangeText: ['const vat = 0.2', 'const reduced = 0.05', 'const zero = 0'], after: ['export { vat }'] },
    })
    expect(readRecord(db, 'notes', added.added.id)!.data!.anchor).toEqual({
      line: 7,
      endLine: 9,
      side: 'new',
      text: 'const vat = 0.2',
      rangeText: ['const vat = 0.2', 'const reduced = 0.05', 'const zero = 0'],
      before: ['// rates'],
      after: ['export { vat }'],
    })
    expect(await call('get_note', { id: added.added.id })).toMatchObject({ line: 7, endLine: 9, lines: '7–9' })
    const listed = await call<{ notes: { id: string; endLine?: number }[] }>('list_notes', { session: 's1', status: 'suggested' })
    expect(listed.notes.find((n) => n.id === added.added.id)).toMatchObject({ endLine: 9 })
    const context = await call<{ pendingSuggestions: { id: string; endLine?: number }[] }>('get_review_context', { session: 's1' })
    expect(context.pendingSuggestions.find((n) => n.id === added.added.id)).toMatchObject({ endLine: 9 })

    const lineOnly = await call<{ added: NoteOut & { endLine?: number } }>('add_note', { ...target, line: 3, endLine: 5 })
    expect(readRecord(db, 'notes', lineOnly.added.id)!.data!.anchor).toEqual({ line: 3, endLine: 5, side: 'new', text: '', before: [], after: [] })
    const single = await call<{ added: NoteOut & { endLine?: number } }>('add_note', { ...target, line: 3, endLine: 3, lineText: 'x' })
    expect(single.added).not.toHaveProperty('endLine')

    expect((await call('add_note', { ...target, line: 7, endLine: 9, lineText: 'only one line' })).error).toContain('lineText has 1 line, but lines 7–9 are 3')
    expect((await call('add_note', { ...target, line: 7, endLine: 5 })).error).toContain('endLine 5 is before line 7')
  })

  it('get_checklist and check_item use the applicable checklists', async () => {
    const { call, db } = await setup()
    type Out = { checklists: { title: string; scope: string; done: string; items: { id: string; checked: boolean }[] }[] }
    const before = await call<Out>('get_checklist', { repo: 'charlesabarnes/invoice-service', branch: 'feature/tax' })
    expect(before.checklists.map((l) => [l.title, l.scope, l.done])).toEqual([
      ['Before push', 'global', '1/2'],
      ['Invoices', 'repo', '0/1'],
    ])
    expect(await call('check_item', { session: 's1', itemId: 'i3' })).toMatchObject({ item: { id: 'i3', checked: true }, done: '1/1' })
    expect(readRecord(db, 'checklistState', pairId('s1', 'i3'))!.data).toEqual({ sessionId: 's1', itemId: 'i3', checked: true })
    expect(await call('check_item', { session: 's1', itemId: 'i1', checked: false })).toMatchObject({ done: '0/2' })
    expect((await call('check_item', { session: 's1', itemId: 'i9' })).error).toContain('No item i9')
  })
})

describe('mcp auth', () => {
  const post = (app: ReturnType<typeof makeApp>['app'], token?: string) =>
    app.request(`${TEST_ORIGIN}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

  it('answers 401 with a pointer to the resource metadata', async () => {
    const { app, cleanup } = makeApp()
    cleanups.push(cleanup)
    const missing = await post(app)
    expect(missing.status).toBe(401)
    expect(missing.headers.get('WWW-Authenticate')).toBe(
      `Bearer resource_metadata="${TEST_ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="codeducky"`,
    )
    const invalid = await post(app, 'cdb_forged')
    expect(invalid.status).toBe(401)
    expect(invalid.headers.get('WWW-Authenticate')).toContain('error="invalid_token"')
  })

  it('accepts api tokens, refuses device session tokens and revoked tokens', async () => {
    const { app, cleanup } = makeApp()
    cleanups.push(cleanup)
    const session = await login(app)
    expect((await post(app, session)).status).toBe(401)
    const { token, info } = (await (await request(app, 'POST', '/api/auth/tokens', { name: 'CLI' }, session)).json()) as {
      token: string
      info: { id: string }
    }
    expect((await post(app, token)).status).toBe(200)
    await request(app, 'DELETE', `/api/auth/tokens/${info.id}`, undefined, session)
    expect((await post(app, token)).status).toBe(401)
  })

  it('refuses GET since the server is stateless', async () => {
    const { app, cleanup, tokens } = makeApp()
    cleanups.push(cleanup)
    const { token } = tokens.issue({ name: 'x', kind: 'api' })
    const res = await app.request(`${TEST_ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } })
    expect(res.status).toBe(405)
  })
})
