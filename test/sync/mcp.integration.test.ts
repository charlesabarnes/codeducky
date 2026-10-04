import 'fake-indexeddb/auto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkedItems, createChecklist } from '../../src/db/checklists'
import { CodeDuckyDb } from '../../src/db/db'
import { addNote } from '../../src/db/notes'
import { saveOpenedRepo } from '../../src/db/repos'
import { startOrResumeSession } from '../../src/db/sessions'
import { acceptSuggestion } from '../../src/db/suggestions'
import { SyncController } from '../../src/sync/controller'
import { signInDevice } from '../support/deviceSignIn'
import { challengeFor, decideConsent, fakeConsent, fakeSignIn, fetchSend, newVerifier } from '../support/fakeSignIn'
import { startServer } from '../support/realServer'

let base = ''
let stop = () => {}

beforeAll(async () => {
  ;({ base, stop } = await startServer())
})

afterAll(() => stop())

const folder = (name: string) => ({ kind: 'directory', name }) as unknown as FileSystemDirectoryHandle
const anchor = { line: 14, side: 'new' as const, text: 'return amount * rate', before: ['function tax(amount) {'], after: ['}'] }

async function callTool<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult
  const text = (result.content[0] as { text: string }).text
  if (result.isError) throw new Error(text)
  return JSON.parse(text) as T
}

describe('MCP against the real server', () => {
  it('resolves and adds notes over MCP, and a synced device receives both', async () => {
    const db = new CodeDuckyDb('mcp-int')
    const controller = new SyncController(db, { baseUrl: base, listenToBrowser: false, debounceMs: 60_000, intervalMs: 3_600_000 })
    try {
      const repoId = await saveOpenedRepo(db, folder('invoice-service'), { owner: 'acme', name: 'invoice-service', defaultBase: 'main' })
      const sessionId = await startOrResumeSession(db, { repoId, branch: 'feature/tax', headSha: 'h', baseSha: 'b' })
      const noteId = await addNote(db, { sessionId, path: 'src/tax.ts', anchor, body: 'Round before multiplying.', severity: 'issue' })
      await addNote(db, { sessionId, path: 'src/tax.ts', anchor: { ...anchor, line: 2 }, body: 'Typo', severity: 'nit' })
      const listId = await createChecklist(db, 'global', { title: 'Before push', items: ['Tests pass'] })
      await signInDevice(controller, db, base, 'alice', 'Laptop')
      const { token } = await controller.mintToken('Claude Code')

      const client = new Client({ name: 'integration', version: '1.0.0' })
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
      )
      try {
        const { notes } = await callTool<{ notes: { id: string; body: string; anchor: { text: string } }[] }>(client, 'list_notes', {
          repo: 'acme/invoice-service',
          branch: 'feature/tax',
          severity: 'issue',
        })
        expect(notes.map((n) => n.id)).toEqual([noteId])
        expect(notes[0]!.anchor.text).toBe('return amount * rate')

        await callTool(client, 'resolve_note', { id: noteId, reply: 'Rounded with `roundHalfEven` first.' })
        const { added } = await callTool<{ added: { id: string } }>(client, 'add_note', {
          repo: 'acme/invoice-service',
          branch: 'feature/tax',
          path: 'src/tax.ts',
          line: 20,
          severity: 'suggestion',
          title: 'Add a test for zero rate',
          body: 'Cover rate = 0.',
        })
        const { checklists } = await callTool<{ checklists: { items: { id: string }[] }[] }>(client, 'get_checklist', {
          session: sessionId,
        })
        await callTool(client, 'check_item', { session: sessionId, itemId: checklists[0]!.items[0]!.id })

        await controller.sync()
        expect(await db.notes.get(noteId)).toMatchObject({
          status: 'resolved',
          resolution: { by: 'mcp:Claude Code', text: 'Rounded with `roundHalfEven` first.' },
        })
        const suggested = await db.notes.get(added.id)
        expect(suggested).toMatchObject({ sessionId, status: 'suggested', source: 'mcp', title: 'Add a test for zero rate' })
        const itemId = (await db.checklists.get(listId))!.items[0]!.id
        expect(await checkedItems(db, sessionId)).toEqual(new Set([itemId]))

        // Accepting the suggestion in the app syncs back and shows up over MCP as an open note.
        await acceptSuggestion(db, added.id)
        await controller.sync()
        const open = await callTool<{ notes: { id: string; source: string }[] }>(client, 'list_notes', { session: sessionId })
        expect(open.notes.map((n) => n.id).sort()).toContain(added.id)
      } finally {
        await client.close()
      }
    } finally {
      controller.dispose()
      await db.delete()
    }
  })

  it('connects an MCP client through GitHub consent, acting only on the data of the user who approved', async () => {
    for (const login of ['carol', 'dave']) {
      const { token } = await fakeSignIn(fetchSend, base, login)
      const repo = { owner: login, name: `${login}-app`, folderName: `${login}-app`, baseBranch: 'main', lastOpenedAt: 1, checklistIds: [] }
      const pushed = await fetch(`${base}/api/sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cursor: 0, changes: [{ kind: 'repos', id: `gh:${login}/${login}-app`, changedAt: 1, deleted: false, data: repo }] }),
      })
      expect(pushed.status).toBe(200)
    }

    const redirectUri = 'http://127.0.0.1:53682/callback'
    const registered = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude Code (integration)', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }),
    })
    const { client_id: clientId } = (await registered.json()) as { client_id: string }
    const verifier = newVerifier()
    const authorizeUrl = `${base}/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challengeFor(verifier),
      code_challenge_method: 'S256',
      state: 'xyz',
      resource: `${base}/mcp`,
    })}`

    const page = await fakeConsent(fetchSend, authorizeUrl, 'carol')
    expect(page.status).toBe(200)
    expect(page.html).toContain('@carol')
    expect(page.html).toContain('Claude Code (integration)')
    const approved = new URL((await decideConsent(fetchSend, base, page, 'approve')).headers.get('location')!)
    expect(approved.searchParams.get('state')).toBe('xyz')

    const tokenRes = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: approved.searchParams.get('code')!,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: redirectUri,
      }).toString(),
    })
    expect(tokenRes.status).toBe(200)
    const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string }

    const client = new Client({ name: 'integration-oauth', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }),
    )
    try {
      const { repos } = await callTool<{ repos: { repo: string }[] }>(client, 'list_repos')
      expect(repos.map((r) => r.repo)).toEqual(['carol/carol-app'])
    } finally {
      await client.close()
    }
  })
})
