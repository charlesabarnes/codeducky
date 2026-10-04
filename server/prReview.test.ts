import { afterEach, describe, expect, it } from 'bun:test'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { SyncResponse, WireChange } from '../shared/sync'
import { note, record, repo, REPO, REPO_ID, session } from './fixtures'
import { login, makeApp, mcpClient, request, TEST_ORIGIN } from './testing'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

const PR = { owner: 'charlesabarnes', name: 'invoice-service', number: 42, title: 'Retry webhooks', url: 'https://github.com/charlesabarnes/invoice-service/pull/42', author: 'octo', baseRef: 'main' }

const SEED: WireChange[] = [
  repo(),
  session('local', 'feature/retry', { startedAt: 3 }),
  session('pr-old', 'feature/retry', { source: 'github-pr', pr: PR, baseSource: 'github', startedAt: 1, status: 'archived', review: { state: 'COMMENTED', at: 9 } }),
  session('pr', 'feature/retry', { source: 'github-pr', pr: PR, baseSource: 'github', startedAt: 4, headSha: 'prhead', baseSha: 'prbase' }),
  note('n-local', 'local'),
  note('n-pr', 'pr', { severity: 'blocker' }),
  record('inbox', 'inbox', {
    fetchedAt: Date.parse('2026-10-03T12:00:00Z'),
    items: [
      { repo: REPO, number: 42, title: 'Retry webhooks', author: 'octo', url: PR.url, updatedAt: '2026-10-03T10:00:00Z', section: 'requested' },
      { repo: 'charlesabarnes/gangway', number: 48, title: 'acme-dns', author: 'charlesabarnes', url: 'https://github.com/charlesabarnes/gangway/pull/48', updatedAt: '2026-10-02T10:00:00Z', section: 'mine' },
    ],
  }),
]

async function setup(changes: WireChange[] = SEED) {
  const made = makeApp()
  cleanups.push(made.cleanup)
  const device = await login(made.app)
  const pushed = (await (await request(made.app, 'POST', '/api/sync', { cursor: 0, changes }, device)).json()) as SyncResponse
  expect(pushed.rejected).toEqual([])
  const { token } = made.tokens.issue({ name: 'Claude Code', kind: 'api' })
  const client = await mcpClient(made.app, token)
  cleanups.push(() => void client.close())
  const call = async <T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult
    const text = (result.content[0] as { text: string }).text
    if (result.isError) return { error: text } as T & { error?: string }
    return JSON.parse(text) as T & { error?: string }
  }
  return { ...made, token, call }
}

const codeDuckyPr = `${TEST_ORIGIN}/pr/charlesabarnes/invoice-service/42`

describe('pull request sessions over MCP', () => {
  it('list_sessions shows the source, PR number and links', async () => {
    const { call } = await setup()
    const { sessions } = await call<{ sessions: Record<string, unknown>[] }>('list_sessions', { repo: REPO })
    const byId = new Map(sessions.map((s) => [s.id, s]))
    expect(byId.get('pr')).toMatchObject({
      source: 'github-pr',
      current: true,
      url: `${TEST_ORIGIN}/sessions/pr`,
      pr: { number: 42, title: 'Retry webhooks', url: PR.url, codeDuckyUrl: codeDuckyPr, headRef: 'feature/retry' },
    })
    expect(byId.get('pr-old')).toMatchObject({ current: false, pr: { review: { state: 'COMMENTED' } } })
    // The local session of the same branch stays current for branch lookups.
    expect(byId.get('local')).toMatchObject({ source: 'local', current: true })
  })

  it('get_review_context includes the pull request and how to read its diff', async () => {
    const { call } = await setup()
    const context = await call<Record<string, unknown>>('get_review_context', { repo: REPO, pr: 42 })
    expect(context.session).toMatchObject({ id: 'pr', source: 'github-pr', headSha: 'prhead', url: `${TEST_ORIGIN}/sessions/pr` })
    expect(context.pullRequest).toMatchObject({ number: 42, codeDuckyUrl: codeDuckyPr, author: 'octo' })
    expect(context.howToReadDiff).toContain('gh pr diff 42 --repo charlesabarnes/invoice-service')
    expect((context.openNotes as { id: string }[]).map((n) => n.id)).toEqual(['n-pr'])

    const local = await call<Record<string, unknown>>('get_review_context', { repo: REPO, branch: 'feature/retry' })
    expect(local.session).toMatchObject({ id: 'local', source: 'local' })
    expect(local.howToReadDiff).toBeUndefined()
    expect((await call('get_review_context', { repo: REPO, pr: 7 })).error).toContain('No Code Ducky session for charlesabarnes/invoice-service#7')
  })

  it('add_note targets a PR session by repo and pr', async () => {
    const { call } = await setup()
    const { added } = await call<{ added: { session: string } }>('add_note', { repo: REPO, pr: 42, path: 'src/a.ts', line: 3, body: 'x' })
    expect(added.session).toBe('pr')
  })

  it('list_review_requests reads the synced inbox', async () => {
    const { call } = await setup()
    const requested = await call<{ fetchedAt: string; items: Record<string, unknown>[] }>('list_review_requests')
    expect(requested.fetchedAt).toBe('2026-10-03T12:00:00.000Z')
    expect(requested.items).toEqual([
      {
        repo: REPO,
        number: 42,
        title: 'Retry webhooks',
        author: 'octo',
        url: PR.url,
        updatedAt: '2026-10-03T10:00:00Z',
        section: 'requested',
        codeDuckyUrl: codeDuckyPr,
        session: 'pr',
        sessionStatus: 'active',
      },
    ])
    const all = await call<{ items: { number: number }[] }>('list_review_requests', { section: 'all' })
    expect(all.items.map((item) => item.number)).toEqual([42, 48])
  })

  it('list_review_requests says when nothing is synced yet', async () => {
    const { call } = await setup([repo()])
    expect(await call('list_review_requests')).toMatchObject({ fetchedAt: null, items: [], note: expect.stringContaining('Inbox') })
  })

  it('the gate links the branch pull request when it fails', async () => {
    const made = await setup([repo(), session('local', 'feature/retry', { pr: { owner: PR.owner, name: PR.name, number: 42 } }), note('n1', 'local')])
    const res = await made.app.request(`${TEST_ORIGIN}/api/gate?repo=${encodeURIComponent(REPO)}&branch=feature%2Fretry&format=text`, {
      headers: { Authorization: `Bearer ${made.token}` },
    })
    expect(await res.text()).toBe(`FAIL\n- issue: src/invoice.ts:12 Body of n1\nurl ${TEST_ORIGIN}/sessions/local\npr ${codeDuckyPr}\n`)
  })
})

describe('repo ids', () => {
  it('keeps the fixture repo id', () => expect(REPO_ID).toBe('gh:charlesabarnes/invoice-service'))
})
