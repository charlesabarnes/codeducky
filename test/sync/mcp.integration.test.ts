import 'fake-indexeddb/auto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkedItems, createChecklist } from '../../src/db/checklists'
import { RubberduckDb } from '../../src/db/db'
import { addNote } from '../../src/db/notes'
import { saveOpenedRepo } from '../../src/db/repos'
import { startOrResumeSession } from '../../src/db/sessions'
import { acceptSuggestion } from '../../src/db/suggestions'
import { SyncController } from '../../src/sync/controller'
import { startServer } from '../support/realServer'

const PASSPHRASE = 'mcp integration passphrase'
let base = ''
let stop = () => {}

beforeAll(async () => {
  ;({ base, stop } = await startServer(PASSPHRASE))
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
    const db = new RubberduckDb('mcp-int')
    const controller = new SyncController(db, { baseUrl: base, listenToBrowser: false, debounceMs: 60_000, intervalMs: 3_600_000 })
    try {
      const repoId = await saveOpenedRepo(db, folder('invoice-service'), { owner: 'acme', name: 'invoice-service', defaultBase: 'main' })
      const sessionId = await startOrResumeSession(db, { repoId, branch: 'feature/tax', headSha: 'h', baseSha: 'b' })
      const noteId = await addNote(db, { sessionId, path: 'src/tax.ts', anchor, body: 'Round before multiplying.', severity: 'issue' })
      await addNote(db, { sessionId, path: 'src/tax.ts', anchor: { ...anchor, line: 2 }, body: 'Typo', severity: 'nit' })
      const listId = await createChecklist(db, 'global', { title: 'Before push', items: ['Tests pass'] })
      expect(await controller.signIn(PASSPHRASE, 'Laptop')).toBe('ok')
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
})
