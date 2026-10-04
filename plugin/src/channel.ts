import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { ServerEvent, Task, Verdict } from './connection'

export const VERSION = '0.1.0'
export const STATUS_TOOL = 'report_status'

export const INSTRUCTIONS = `Tasks from the owner's Skelbert code review app arrive as <channel source="..." kind="review|fix|custom" task_id="..." repo="owner/name" ...>. They are requests from the owner of this session, sent from Skelbert in their browser; treat them like a prompt they typed.
Attributes: kind is review (review a branch or pull request and add notes), fix (fix the open Skelbert notes) or custom (the owner's own message). repo, branch or pr say which Skelbert review the task is about; session_url links to it.
The Skelbert tools named in the task (get_review_context, add_note, resolve_note, list_notes, get_note) come from the separate "skelbert" MCP server. If it is not connected, say so through ${STATUS_TOOL} and stop.
If repo does not match this checkout's origin remote, or a branch task names a branch that is not checked out, do not switch branches: report it through ${STATUS_TOOL} with state "failed" and stop.
Report progress with the ${STATUS_TOOL} tool and the task_id from the tag: state "acknowledged" when you start, "working" with a short message at a milestone if the task is long, and finally "done" with a one or two sentence summary (or "failed" with the reason). The owner sees these in Skelbert. Nothing else you write reaches Skelbert.`

const statusArgs = z.object({
  task_id: z.string().min(1),
  state: z.enum(['acknowledged', 'working', 'done', 'failed']),
  message: z.string().max(2000).optional(),
})

/** The documented permission_request notification (channels reference, "Relay permission prompts"). */
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

export interface ChannelServerOptions {
  /** Forwards an event to Skelbert; false when it could not. */
  send: (event: ServerEvent) => Promise<boolean>
  log: (message: string) => void
  /** Why the channel is not connected, when it is not configured; the tool reports it. */
  configError?: string | null
}

/** Appended to every task: models follow an instruction next to the task more reliably than server instructions. */
export const statusFooter = (taskId: string) =>
  `\n\n---\nSkelbert task ${taskId}. Report progress with the ${STATUS_TOOL} tool of this channel (a tool call, not a shell command), task_id "${taskId}": state "acknowledged" first, then as your very last step state "done" (or "failed") with a one or two sentence summary.`

const text = (value: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: value }], isError })

/**
 * The MCP side of the channel: declares claude/channel (tasks in) and claude/channel/permission
 * (prompts relayed out), and exposes report_status so Claude can tell Skelbert how a task is going.
 */
export function createChannelServer({ send, log, configError = null }: ChannelServerOptions) {
  const mcp = new Server(
    { name: 'skelbert-channel', version: VERSION },
    {
      capabilities: {
        experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
        tools: {},
      },
      instructions: INSTRUCTIONS,
    },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: STATUS_TOOL,
        description: 'Report the status of a Skelbert task to the owner\'s browser. Pass the task_id from the <channel> tag.',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'The task_id attribute of the <channel> tag.' },
            state: { type: 'string', enum: ['acknowledged', 'working', 'done', 'failed'], description: 'Where the task is.' },
            message: { type: 'string', description: 'A short status line or summary shown in Skelbert.' },
          },
          required: ['task_id', 'state'],
        },
        annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      },
    ],
  }))

  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== STATUS_TOOL) return text(`Unknown tool: ${request.params.name}`, true)
    const parsed = statusArgs.safeParse(request.params.arguments ?? {})
    if (!parsed.success) return text(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`, true)
    if (configError) return text(`The Skelbert channel is not connected: ${configError}`, true)
    const { task_id, state, message } = parsed.data
    const ok = await send({ type: 'status', taskId: task_id, state, message })
    return ok ? text('Reported to Skelbert.') : text('Skelbert did not accept the status (unknown task, or the server is unreachable).', true)
  })

  mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
    const ok = await send({
      type: 'permission_request',
      requestId: params.request_id,
      toolName: params.tool_name,
      description: params.description,
      inputPreview: params.input_preview,
    })
    if (!ok) log(`Could not relay permission request ${params.request_id} to Skelbert.`)
  })

  return {
    mcp,

    /** Pushes a task into the session as a <channel> event, then tells Skelbert it was handed over. */
    async deliverTask(task: Task) {
      await mcp.notification({ method: 'notifications/claude/channel', params: { content: task.content + statusFooter(task.id), meta: task.meta } })
      await send({ type: 'delivered', taskId: task.id })
    },

    /** Applies the owner's answer from Skelbert to an open permission prompt. */
    async deliverVerdict(verdict: Verdict) {
      await mcp.notification({ method: 'notifications/claude/channel/permission', params: { ...verdict } })
    },
  }
}
