import { describe, expect, it } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { createChannelServer, STATUS_TOOL, statusFooter } from '../src/channel'
import type { ServerEvent } from '../src/connection'

const ChannelNotification = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
})
const VerdictNotification = z.object({
  method: z.literal('notifications/claude/channel/permission'),
  params: z.object({ request_id: z.string(), behavior: z.enum(['allow', 'deny']) }),
})

/** A stand-in for Claude Code: an MCP client over an in-memory transport that records channel notifications. */
async function setup(options: { accept?: boolean; configError?: string } = {}) {
  const sent: ServerEvent[] = []
  const logs: string[] = []
  const channel = createChannelServer({
    send: async (event) => {
      sent.push(event)
      return options.accept ?? true
    },
    log: (message) => logs.push(message),
    configError: options.configError ?? null,
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'claude-code-stand-in', version: '1.0.0' })
  const received: unknown[] = []
  client.setNotificationHandler(ChannelNotification, (n) => void received.push(n))
  client.setNotificationHandler(VerdictNotification, (n) => void received.push(n))
  await Promise.all([channel.mcp.connect(serverTransport), client.connect(clientTransport)])
  return { channel, client, sent, logs, received }
}

const flush = () => new Promise((r) => setTimeout(r, 10))

describe('channel MCP server', () => {
  it('declares the channel and permission relay capabilities, instructions and the status tool', async () => {
    const { client } = await setup()
    const capabilities = client.getServerCapabilities()
    expect(capabilities?.experimental).toEqual({ 'claude/channel': {}, 'claude/channel/permission': {} })
    expect(capabilities?.tools).toEqual({})
    expect(client.getInstructions()).toContain('<channel source=')
    expect(client.getInstructions()).toContain(STATUS_TOOL)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual([STATUS_TOOL])
    expect(tools[0]!.inputSchema.required).toEqual(['task_id', 'state'])
  })

  it('pushes a task as a channel notification and reports it delivered', async () => {
    const { channel, sent, received } = await setup()
    await channel.deliverTask({ id: 't-1', content: 'Review branch feature/tax', meta: { kind: 'review', task_id: 't-1', repo: 'acme/app' } })
    await flush()
    expect(received).toEqual([
      { method: 'notifications/claude/channel', params: { content: `Review branch feature/tax${statusFooter('t-1')}`, meta: { kind: 'review', task_id: 't-1', repo: 'acme/app' } } },
    ])
    expect(sent).toEqual([{ type: 'delivered', taskId: 't-1' }])
    expect(statusFooter('t-1')).toContain('report_status tool of this channel (a tool call, not a shell command), task_id "t-1"')
  })

  it('forwards report_status calls to Code Ducky and validates them', async () => {
    const { client, sent } = await setup()
    const ok = (await client.callTool({ name: STATUS_TOOL, arguments: { task_id: 't-1', state: 'done', message: 'Added 2 notes' } })) as CallToolResult
    expect(ok.isError).toBeFalsy()
    expect(sent).toEqual([{ type: 'status', taskId: 't-1', state: 'done', message: 'Added 2 notes' }])

    const bad = (await client.callTool({ name: STATUS_TOOL, arguments: { task_id: 't-1', state: 'finished' } })) as CallToolResult
    expect(bad.isError).toBe(true)
    const unknown = (await client.callTool({ name: 'nope', arguments: {} })) as CallToolResult
    expect(unknown.isError).toBe(true)
    expect(sent).toHaveLength(1)
  })

  it('tells Claude when Code Ducky refuses a status or the channel is not configured', async () => {
    const refused = await setup({ accept: false })
    const result = (await refused.client.callTool({ name: STATUS_TOOL, arguments: { task_id: 'x', state: 'acknowledged' } })) as CallToolResult
    expect(result.isError).toBe(true)

    const unconfigured = await setup({ configError: 'No Code Ducky URL' })
    const missing = (await unconfigured.client.callTool({ name: STATUS_TOOL, arguments: { task_id: 'x', state: 'acknowledged' } })) as CallToolResult
    expect(missing.isError).toBe(true)
    expect((missing.content[0] as { text: string }).text).toContain('No Code Ducky URL')
    expect(unconfigured.sent).toEqual([])
  })

  it('relays permission requests out and verdicts back in', async () => {
    const { channel, client, sent, received } = await setup()
    await client.notification({
      method: 'notifications/claude/channel/permission_request',
      params: { request_id: 'abcde', tool_name: 'Bash', description: 'Run the tests', input_preview: '{"command":"npm test"}' },
    })
    await flush()
    expect(sent).toEqual([{ type: 'permission_request', requestId: 'abcde', toolName: 'Bash', description: 'Run the tests', inputPreview: '{"command":"npm test"}' }])

    await channel.deliverVerdict({ request_id: 'abcde', behavior: 'allow' })
    await flush()
    expect(received).toEqual([{ method: 'notifications/claude/channel/permission', params: { request_id: 'abcde', behavior: 'allow' } }])
  })
})
