import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { createChannelRegistry } from './channel/registry'
import { login, makeApp, request } from './testing'

const ChannelNotification = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
})
const VerdictNotification = z.object({
  method: z.literal('notifications/claude/channel/permission'),
  params: z.object({ request_id: z.string(), behavior: z.string() }),
})

async function until<T>(read: () => T | undefined | null | false, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(25)
  }
}

/** The plugin as Claude Code runs it: a subprocess on stdio, pointed at a real Code Ducky server over HTTP. */
describe('channel plugin against a running server', () => {
  const ctx = makeApp({ channel: createChannelRegistry({ heartbeatMs: 1000 }) })
  const http = Bun.serve({ port: 0, fetch: ctx.app.fetch, idleTimeout: 30 })
  const base = `http://localhost:${http.port}`
  const checkout = mkdtempSync(join(tmpdir(), 'codeducky-channel-repo-'))
  let browser = ''
  let client: Client
  const channelMessages: z.infer<typeof ChannelNotification>['params'][] = []
  const verdicts: z.infer<typeof VerdictNotification>['params'][] = []
  let stderr = ''

  beforeAll(async () => {
    const git = (...args: string[]) => spawnSync('git', args, { cwd: checkout, stdio: 'ignore' })
    git('init', '-q', '-b', 'feature/tax')
    git('remote', 'add', 'origin', 'git@github.com:acme/invoice-service.git')

    browser = await login(ctx.app)
    const minted = await request(ctx.app, 'POST', '/api/auth/tokens', { name: 'Claude channel' }, browser)
    const { token } = (await minted.json()) as { token: string }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(import.meta.dir, '../plugin/server.ts')],
      cwd: checkout,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', CODEDUCKY_URL: base, CODEDUCKY_TOKEN: token },
      stderr: 'pipe',
    })
    transport.stderr?.on('data', (chunk) => (stderr += String(chunk)))
    client = new Client({ name: 'claude-code-stand-in', version: '1.0.0' })
    client.setNotificationHandler(ChannelNotification, ({ params }) => void channelMessages.push(params))
    client.setNotificationHandler(VerdictNotification, ({ params }) => void verdicts.push(params))
    await client.connect(transport)
  })

  afterAll(async () => {
    await client?.close().catch(() => undefined)
    await http.stop(true)
    ctx.cleanup()
    rmSync(checkout, { recursive: true, force: true })
  })

  it('registers, takes a task, reports status and relays a permission prompt', async () => {
    expect(client.getServerCapabilities()?.experimental).toEqual({ 'claude/channel': {}, 'claude/channel/permission': {} })

    const session = await until(() => ctx.channel.state().sessions.find((s) => s.connected), `registration (stderr: ${stderr})`)
    expect(session).toMatchObject({ repo: 'acme/invoice-service', branch: 'feature/tax', tokenName: 'Claude channel', pluginVersion: '0.1.0' })
    expect(session.label).toMatch(/^codeducky-channel-repo-\w+ on /)

    const sent = await request(
      ctx.app,
      'POST',
      `/api/channel/sessions/${session.id}/tasks`,
      { kind: 'custom', target: { repo: 'acme/invoice-service', branch: 'feature/tax' }, message: 'Explain the tax rounding.' },
      browser,
    )
    const { task } = (await sent.json()) as { task: { id: string } }
    const message = await until(() => channelMessages[0], 'the channel notification')
    expect(message.content).toStartWith('Explain the tax rounding.')
    expect(message.meta).toMatchObject({ kind: 'custom', task_id: task.id, repo: 'acme/invoice-service', branch: 'feature/tax' })
    await until(() => ctx.channel.state().tasks[0]?.state === 'delivered', 'delivery')

    const result = (await client.callTool({ name: 'report_status', arguments: { task_id: task.id, state: 'done', message: 'Explained.' } })) as CallToolResult
    expect(result.isError).toBeFalsy()
    expect(ctx.channel.state().tasks[0]).toMatchObject({ state: 'done', message: 'Explained.' })

    await client.notification({
      method: 'notifications/claude/channel/permission_request',
      params: { request_id: 'mnopq', tool_name: 'Bash', description: 'Run the tests', input_preview: '{"command":"npm test"}' },
    })
    await until(() => ctx.channel.state().permissions[0], 'the permission request')
    const answered = await request(ctx.app, 'POST', `/api/channel/sessions/${session.id}/permissions/mnopq`, { behavior: 'allow' }, browser)
    expect(answered.status).toBe(200)
    expect(await until(() => verdicts[0], 'the verdict')).toEqual({ request_id: 'mnopq', behavior: 'allow' })
  })

  it('unregisters when Claude Code closes the session', async () => {
    await client.close()
    await until(() => ctx.channel.state().sessions.length === 0, 'unregistering')
  })
})
