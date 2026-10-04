import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { pairId, type SyncResponse, type WireChange } from '../shared/sync'
import { checklist, note, record, repo, REPO, REPO_ID, session, ticked } from './fixtures'
import { readRecord } from './records/store'
import { createUserSession, makeApp, mcpClient, request } from './testing'

const PR = { owner: 'charlesabarnes', name: 'invoice-service', number: 42, title: 'Retry webhooks', url: 'https://github.com/charlesabarnes/invoice-service/pull/42', author: 'octo', baseRef: 'main' }

const ALICE_SECRET = 'Alice-only rule: never log card numbers.'

const ALICE: WireChange[] = [
  repo({ instructions: ALICE_SECRET }),
  session('alice-s1', 'feature/tax'),
  session('alice-pr', 'feature/retry', { source: 'github-pr', pr: PR, baseSource: 'github' }),
  note('alice-n1', 'alice-s1', { body: 'Alice private finding' }),
  note('alice-n2', 'alice-pr', { severity: 'blocker' }),
  checklist('alice-cl', 'Alice checklist', [['alice-i1', 'Alice item']]),
  ticked('alice-s1', 'alice-i1'),
  record('inbox', 'inbox', {
    fetchedAt: 1,
    items: [{ repo: REPO, number: 42, title: 'Retry webhooks', author: 'octo', url: PR.url, updatedAt: '2026-10-03T10:00:00Z', section: 'requested' }],
  }),
]

/** Bob reviews a repo with the same deterministic id as Alice's, so ids collide by design. */
const BOB: WireChange[] = [repo(), session('bob-s1', 'bob-branch')]

type Call = <T = Record<string, unknown>>(name: string, args?: Record<string, unknown>) => Promise<T & { error?: string }>

const ctx = makeApp()
const clients: Client[] = []

async function signIn(login: string, changes: WireChange[]) {
  const { token: device, user } = createUserSession(ctx.db, login)
  const pushed = (await (await request(ctx.app, 'POST', '/api/sync', { cursor: 0, changes }, device)).json()) as SyncResponse
  expect(pushed.rejected).toEqual([])
  const { token } = ctx.tokens.issue({ userId: user.id, name: `${login} Claude`, kind: 'api' })
  const client = await mcpClient(ctx.app, token)
  clients.push(client)
  const call: Call = async (name, args = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult
    const text = (result.content[0] as { text: string }).text
    return (result.isError ? { error: text } : JSON.parse(text)) as never
  }
  return { user, client, call }
}

let alice: Awaited<ReturnType<typeof signIn>>
let bob: Awaited<ReturnType<typeof signIn>>

beforeAll(async () => {
  alice = await signIn('alice', ALICE)
  bob = await signIn('bob', BOB)
})

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()))
  ctx.cleanup()
})

const aliceRecord = (kind: Parameters<typeof readRecord>[2], id: string) => readRecord(ctx.db, alice.user.id, kind, id)

/** Each tool, called by Bob with Alice's session, note and item ids, repos and branches. */
const TOOL_CASES: Record<string, () => Promise<void>> = {
  async get_review_context() {
    expect((await bob.call('get_review_context', { session: 'alice-s1' })).error).toBe('No session with id alice-s1. Use list_sessions to find one.')
    const byBranch = await bob.call('get_review_context', { repo: REPO, branch: 'feature/tax' })
    expect(byBranch.error).toBe(`No Code Ducky session for ${REPO}@feature/tax; the user has to open it in Code Ducky first. Branches with sessions: bob-branch.`)
    expect((await bob.call('get_review_context', { repo: REPO, pr: 42 })).error).toContain(`No Code Ducky session for ${REPO}#42`)
    const own = await bob.call('get_review_context', { repo: REPO, branch: 'bob-branch' })
    expect(JSON.stringify(own)).not.toContain('alice')
    expect(JSON.stringify(own)).not.toContain(ALICE_SECRET)
  },
  async list_repos() {
    const { repos } = await bob.call<{ repos: { repo: string; branches: { branch: string; session: string; openNotes: number }[] }[] }>('list_repos')
    expect(repos).toMatchObject([{ repo: REPO, branches: [{ branch: 'bob-branch', session: 'bob-s1', openNotes: 0 }] }])
  },
  async list_sessions() {
    expect((await bob.call<{ sessions: { id: string }[] }>('list_sessions')).sessions.map((s) => s.id)).toEqual(['bob-s1'])
    expect((await bob.call<{ sessions: unknown[] }>('list_sessions', { repo: REPO, branch: 'feature/tax' })).sessions).toEqual([])
    expect((await bob.call('list_sessions', { repo: 'someone/else' })).error).toBe('No repo matches "someone/else". Known repos: charlesabarnes/invoice-service.')
  },
  async list_notes() {
    expect(await bob.call('list_notes', { status: 'all', allSessions: true })).toMatchObject({ total: 0, notes: [] })
    expect((await bob.call('list_notes', { session: 'alice-s1' })).error).toContain('No session with id alice-s1')
    expect((await bob.call('list_notes', { repo: REPO, pr: 42 })).error).toContain(`No Code Ducky session for ${REPO}#42`)
  },
  async get_note() {
    expect((await bob.call('get_note', { id: 'alice-n1' })).error).toBe('No note with id alice-n1.')
  },
  async resolve_note() {
    expect((await bob.call('resolve_note', { id: 'alice-n1', reply: 'Fixed by bob' })).error).toBe('No note with id alice-n1.')
    expect(aliceRecord('notes', 'alice-n1')!.data).toMatchObject({ status: 'open', body: 'Alice private finding' })
    expect(readRecord(ctx.db, bob.user.id, 'notes', 'alice-n1')).toBeNull()
  },
  async add_note() {
    expect((await bob.call('add_note', { session: 'alice-s1', path: 'a.ts', line: 1, body: 'x' })).error).toContain('No session with id alice-s1')
    expect((await bob.call('add_note', { repo: REPO, branch: 'feature/tax', path: 'a.ts', line: 1, body: 'x' })).error).toContain('Branches with sessions: bob-branch.')
    expect((await bob.call('add_note', { repo: REPO, pr: 42, path: 'a.ts', line: 1, body: 'x' })).error).toContain('#42')
    const added = await bob.call<{ added: { id: string } }>('add_note', { session: 'bob-s1', path: 'a.ts', line: 1, body: 'Bob note' })
    expect(aliceRecord('notes', added.added.id)).toBeNull()
  },
  async list_review_requests() {
    expect(await bob.call('list_review_requests', { section: 'all' })).toMatchObject({ fetchedAt: null, items: [] })
  },
  async get_checklist() {
    expect((await bob.call('get_checklist', { session: 'alice-s1' })).error).toContain('No session with id alice-s1')
    const own = await bob.call<{ checklists: unknown[] }>('get_checklist', { session: 'bob-s1' })
    expect(own.checklists).toEqual([])
  },
  async check_item() {
    expect((await bob.call('check_item', { session: 'alice-s1', itemId: 'alice-i1', checked: false })).error).toContain('No session with id alice-s1')
    expect((await bob.call('check_item', { session: 'bob-s1', itemId: 'alice-i1' })).error).toContain('No item alice-i1')
    expect(aliceRecord('checklistState', pairId('alice-s1', 'alice-i1'))!.data).toMatchObject({ checked: true })
  },
}

/** Each prompt, asked by Bob for the repo id Alice and Bob share: Alice's repo instructions stay out. */
const PROMPT_CASES: Record<string, () => Promise<void>> = {
  async review() {
    const text = await promptText(bob.client, 'review')
    expect(text).not.toContain(ALICE_SECRET)
    expect(text).not.toContain('My instructions for this repo')
    expect(await promptText(alice.client, 'review')).toContain(ALICE_SECRET)
  },
  async fix() {
    expect(await promptText(bob.client, 'fix')).not.toContain(ALICE_SECRET)
    expect(await promptText(alice.client, 'fix')).toContain(ALICE_SECRET)
  },
}

async function promptText(client: Client, name: string) {
  const result = await client.getPrompt({ name, arguments: { repo: REPO, branch: 'feature/tax' } })
  const content = result.messages[0]!.content
  return content.type === 'text' ? content.text : ''
}

describe('mcp across users', () => {
  it('has a cross-user case for every tool and prompt', async () => {
    const { tools } = await bob.client.listTools()
    const { prompts } = await bob.client.listPrompts()
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(TOOL_CASES).sort())
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual(Object.keys(PROMPT_CASES).sort())
  })

  for (const [name, check] of Object.entries(TOOL_CASES)) it(`tool ${name} sees and changes only the caller's data`, check)
  for (const [name, check] of Object.entries(PROMPT_CASES)) it(`prompt ${name} inlines only the caller's repo instructions`, check)

  it('leaves Alice\'s view unchanged', async () => {
    const { repos } = await alice.call<{ repos: { id: string; branches: { branch: string }[] }[] }>('list_repos')
    expect(repos).toMatchObject([{ id: REPO_ID }])
    expect(repos[0]!.branches.map((b) => b.branch).sort()).toEqual(['feature/retry', 'feature/tax'])
    const notes = await alice.call<{ notes: { id: string; status: string }[] }>('list_notes', { status: 'all', allSessions: true })
    expect(notes.notes.map((n) => [n.id, n.status]).sort()).toEqual([
      ['alice-n1', 'open'],
      ['alice-n2', 'open'],
    ])
    expect((await alice.call<{ items: unknown[] }>('list_review_requests', { section: 'all' })).items).toHaveLength(1)
  })
})
