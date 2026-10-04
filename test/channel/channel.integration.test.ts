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
import { CodeDuckyDb } from '../../src/db/db'
import { SyncController } from '../../src/sync/controller'
import { signInDevice } from '../support/deviceSignIn'
import { fakeSignIn, fetchSend } from '../support/fakeSignIn'
import { startServer } from '../support/realServer'

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
const checkout = mkdtempSync(join(tmpdir(), 'codeducky-channel-int-'))

beforeAll(async () => {
  ;({ base, stop } = await startServer())
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
    const db = new CodeDuckyDb('channel-int')
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
      await signInDevice(controller, db, base, 'alice', 'Laptop')
      await vi.waitFor(() => expect(channel.getSnapshot().status).toBe('live'), { timeout: 10_000 })
      const { token } = await controller.mintToken('Claude channel')

      await client.connect(
        new StdioClientTransport({
          command: bun,
          args: [resolve('plugin/server.ts')],
          cwd: checkout,
          env: { PATH: process.env.PATH ?? '', HOME: homedir(), CODEDUCKY_URL: base, CODEDUCKY_TOKEN: token },
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
      expect(messages[0]!.content).toContain('Work through the Code Ducky review notes on my branch')
      expect(messages[0]!.meta).toMatchObject({ kind: 'fix', task_id: task.id, codeducky_session: 'local-1', session_url: `${base}/sessions/local-1` })

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

  it('keeps one user\'s plugin sessions, tasks and prompts away from another', async () => {
    const alice = await fakeSignIn(fetchSend, base, 'chan-alice')
    const bob = await fakeSignIn(fetchSend, base, 'chan-bob')
    const call = (method: string, path: string, token: string, body?: unknown) =>
      fetch(`${base}/api/channel${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    const minted = (await (await fetch(`${base}/api/auth/tokens`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice channel' }),
    }).then((res) => res.json())) as { token: string }).token
    const registration = { id: 'chan-int-alice-01', label: 'alice laptop', cwd: '/src', repo: 'acme/invoice-service', branch: 'b', hostname: 'h', pluginVersion: '0.1.0' }
    const stream = await call('POST', '/stream', minted, registration)
    expect(stream.status).toBe(200)
    const reader = stream.body!.getReader()
    try {
      await reader.read()
      const target = { kind: 'review', target: { repo: 'acme/invoice-service', branch: 'b' } }
      expect((await call('POST', `/sessions/${registration.id}/tasks`, alice.token, target)).status).toBe(200)
      const prompt = { type: 'permission_request', requestId: 'pqrst', toolName: 'Bash', description: '', inputPreview: '' }
      expect((await call('POST', `/sessions/${registration.id}/events`, minted, prompt)).status).toBe(200)

      expect(await (await call('GET', '/sessions', bob.token)).json()).toEqual({ sessions: [], tasks: [], permissions: [] })
      expect((await call('POST', `/sessions/${registration.id}/tasks`, bob.token, target)).status).toBe(404)
      expect((await call('POST', `/sessions/${registration.id}/permissions/pqrst`, bob.token, { behavior: 'allow' })).status).toBe(404)

      const own = (await (await call('GET', '/sessions', alice.token)).json()) as { sessions: unknown[]; tasks: unknown[]; permissions: { state: string }[] }
      expect(own.sessions).toHaveLength(1)
      expect(own.tasks).toHaveLength(1)
      expect(own.permissions).toMatchObject([{ state: 'pending' }])
    } finally {
      await reader.cancel()
    }
  })
})
