import 'fake-indexeddb/auto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ChannelClient } from '../../src/channel/client'
import { RubberduckDb } from '../../src/db/db'
import { SyncController } from '../../src/sync/controller'
import { startServer } from '../support/realServer'

const PASSPHRASE = 'channel integration passphrase'
const bun = process.env.BUN_PATH ?? (existsSync(join(homedir(), '.bun/bin/bun')) ? join(homedir(), '.bun/bin/bun') : 'bun')

const ChannelNotification = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
})
const VerdictNotification = z.object({
  method: z.literal('notifications/claude/channel/permission'),
  params: z.object({ request_id: z.string(), behavior: z.string() }),
})

let base = ''
let stop = () => {}
const checkout = mkdtempSync(join(tmpdir(), 'rubberduck-channel-int-'))

beforeAll(async () => {
  ;({ base, stop } = await startServer(PASSPHRASE))
  const git = (...args: string[]) => spawnSync('git', args, { cwd: checkout, stdio: 'ignore' })
  git('init', '-q', '-b', 'feature/tax')
  git('remote', 'add', 'origin', 'https://github.com/acme/invoice-service.git')
})

afterAll(() => {
  stop()
  rmSync(checkout, { recursive: true, force: true })
})

describe('Send to Claude against the real server', () => {
  it('relays a task from the PWA to the plugin and status and a permission prompt back', async () => {
    const db = new RubberduckDb('channel-int')
    const controller = new SyncController(db, { baseUrl: base, listenToBrowser: false, debounceMs: 60_000, intervalMs: 3_600_000 })
    const channel = new ChannelClient({
      token: () => controller.authToken(),
      onAuthChange: (listener) => controller.subscribe(listener),
      request: (method, path, body) => controller.request(method, path, body),
      baseUrl: base,
    })
    const unsubscribe = channel.subscribe(() => undefined)
    const client = new Client({ name: 'claude-code-stand-in', version: '1.0.0' })
    const messages: z.infer<typeof ChannelNotification>['params'][] = []
    const verdicts: z.infer<typeof VerdictNotification>['params'][] = []
    client.setNotificationHandler(ChannelNotification, ({ params }) => void messages.push(params))
    client.setNotificationHandler(VerdictNotification, ({ params }) => void verdicts.push(params))
    try {
      expect(await controller.signIn(PASSPHRASE, 'Laptop')).toBe('ok')
      await vi.waitFor(() => expect(channel.getSnapshot().status).toBe('live'), { timeout: 10_000 })
      const { token } = await controller.mintToken('Claude channel')

      await client.connect(
        new StdioClientTransport({
          command: bun,
          args: [resolve('plugin/server.ts')],
          cwd: checkout,
          env: { PATH: process.env.PATH ?? '', HOME: homedir(), RUBBERDUCK_URL: base, RUBBERDUCK_TOKEN: token },
          stderr: 'ignore',
        }),
      )
      await vi.waitFor(() => expect(channel.getSnapshot().state.sessions[0]?.connected).toBe(true), { timeout: 10_000 })
      const session = channel.getSnapshot().state.sessions[0]!
      expect(session).toMatchObject({ repo: 'acme/invoice-service', branch: 'feature/tax', tokenName: 'Claude channel' })

      // Longer than Bun's default 10 s idle timeout: the heartbeat and idleTimeout keep both streams open.
      await new Promise((r) => setTimeout(r, 12_000))
      expect(channel.getSnapshot().status).toBe('live')
      expect(channel.getSnapshot().state.sessions[0]!.connected).toBe(true)

      const { task } = await channel.sendTask(session.id, { kind: 'fix', target: { repo: 'acme/invoice-service', branch: 'feature/tax', sessionId: 'local-1' } })
      await vi.waitFor(() => expect(messages).toHaveLength(1))
      expect(messages[0]!.content).toContain('Work through the Rubberduck review notes on my branch')
      expect(messages[0]!.meta).toMatchObject({ kind: 'fix', task_id: task.id, rubberduck_session: 'local-1', session_url: `${base}/sessions/local-1` })

      await client.callTool({ name: 'report_status', arguments: { task_id: task.id, state: 'working', message: 'Fixing 2 notes' } })
      await vi.waitFor(() => expect(channel.getSnapshot().state.tasks[0]).toMatchObject({ state: 'working', message: 'Fixing 2 notes' }))

      await client.notification({
        method: 'notifications/claude/channel/permission_request',
        params: { request_id: 'vwxyz', tool_name: 'Edit', description: 'Round the tax', input_preview: '{"file_path":"src/tax.ts"}' },
      })
      await vi.waitFor(() => expect(channel.getSnapshot().state.permissions[0]).toMatchObject({ requestId: 'vwxyz', taskId: task.id, state: 'pending' }))
      await channel.decide(session.id, 'vwxyz', 'deny')
      await vi.waitFor(() => expect(verdicts).toEqual([{ request_id: 'vwxyz', behavior: 'deny' }]))
      await vi.waitFor(() => expect(channel.getSnapshot().state.permissions[0]!.state).toBe('deny'))

      await client.close()
      await vi.waitFor(() => expect(channel.getSnapshot().state.sessions).toEqual([]), { timeout: 10_000 })
    } finally {
      unsubscribe()
      await client.close().catch(() => undefined)
      controller.dispose()
    }
  })
})
