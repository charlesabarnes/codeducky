/**
 * The "Send to Claude" channel: Claude Code sessions running the Code Ducky channel plugin connect out to
 * the server, and the PWA sends them tasks. These are the shapes the server and the PWA exchange; the
 * plugin (plugin/) is a separate package and keeps its own copy of the wire format.
 */

export const TASK_KINDS = ['review', 'fix', 'custom'] as const
export type ChannelTaskKind = (typeof TASK_KINDS)[number]

/**
 * queued: the session is reconnecting, the task waits on the server. sent: written to the plugin's stream.
 * delivered: the plugin handed it to Claude Code. The rest are reported by Claude through the plugin's tool.
 */
export type ChannelTaskState = 'queued' | 'sent' | 'delivered' | 'acknowledged' | 'working' | 'done' | 'failed'
/** The states Claude reports itself. */
export const REPORTED_STATES = ['acknowledged', 'working', 'done', 'failed'] as const
export type ReportedState = (typeof REPORTED_STATES)[number]

export type PermissionState = 'pending' | 'allow' | 'deny' | 'expired'
export type PermissionBehavior = 'allow' | 'deny'

/** Claude Code's permission request ids: five lowercase letters, never "l". */
export const PERMISSION_REQUEST_ID = /^[a-km-z]{5}$/

export interface ChannelSessionView {
  id: string
  label: string
  cwd: string
  /** "owner/name" from the checkout's origin remote, when it has one. */
  repo: string | null
  branch: string | null
  hostname: string
  pluginVersion: string
  /** The access token the plugin connected with, as named under Access tokens. */
  tokenName: string
  connected: boolean
  connectedAt: number
  lastSeenAt: number
}

export interface ChannelTaskView {
  id: string
  channelId: string
  kind: ChannelTaskKind
  repo: string
  branch: string | null
  pr: number | null
  /** The Code Ducky session the task was sent from. */
  sessionId: string | null
  state: ChannelTaskState
  /** Claude's last status message. */
  message: string | null
  createdAt: number
  updatedAt: number
}

export interface PermissionView {
  channelId: string
  requestId: string
  /** The newest unfinished task of that Claude session when the prompt opened. */
  taskId: string | null
  toolName: string
  description: string
  inputPreview: string
  state: PermissionState
  createdAt: number
  decidedAt: number | null
}

export interface ChannelState {
  sessions: ChannelSessionView[]
  tasks: ChannelTaskView[]
  permissions: PermissionView[]
}

export interface TaskTarget {
  repo: string
  branch?: string
  pr?: number
  /** The Code Ducky session id, for links back. */
  sessionId?: string
}

/** A note included with a custom message, as the PWA has it. */
export interface TaskNote {
  id: string
  path: string
  line: number
  severity: string
  title?: string
  body: string
}

export interface TaskRequest {
  kind: ChannelTaskKind
  target: TaskTarget
  message?: string
  notes?: TaskNote[]
}

export const MAX_TASK_MESSAGE = 4000
export const MAX_TASK_NOTES = 20
export const MAX_NOTE_EXCERPT = 500

const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase()

/**
 * Connected sessions that can take a task for this repo, best first: same repo and branch, then same repo.
 * Sessions in other repos are left out; disconnected ones sort after connected ones.
 */
export function matchSessions(sessions: ChannelSessionView[], repo: string, branch?: string | null): ChannelSessionView[] {
  const score = (s: ChannelSessionView) => (s.connected ? 2 : 0) + (branch && sameText(s.branch, branch) ? 1 : 0)
  return sessions
    .filter((s) => sameText(s.repo, repo))
    .sort((a, b) => score(b) - score(a) || b.lastSeenAt - a.lastSeenAt)
}

export const isFinished = (state: ChannelTaskState) => state === 'done' || state === 'failed'
