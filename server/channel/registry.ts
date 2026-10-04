import { randomUUID } from 'node:crypto'
import {
  isFinished,
  type ChannelSessionView,
  type ChannelState,
  type ChannelTaskKind,
  type ChannelTaskState,
  type ChannelTaskView,
  type PermissionBehavior,
  type PermissionView,
  type ReportedState,
} from '../../shared/channel'

/** What the plugin says about itself when it connects. */
export interface Registration {
  id: string
  label: string
  cwd: string
  repo: string | null
  branch: string | null
  hostname: string
  pluginVersion: string
}

/** The access token behind a plugin connection. OAuth tokens rotate, so their grant is what stays the same. */
export interface ChannelOwner {
  tokenId: string
  grantId: string | null
  tokenName: string
}

export type TaskMeta = Record<string, string>

/** Events written to a plugin's stream. */
export type PluginEvent =
  | { event: 'ready'; data: { id: string; heartbeatMs: number } }
  | { event: 'task'; data: { id: string; content: string; meta: TaskMeta } }
  | { event: 'verdict'; data: { request_id: string; behavior: PermissionBehavior } }
  | { event: 'ping'; data: Record<string, never> }

/** Writes one event to a plugin's stream; returns false when the stream is gone. */
export type PluginSink = (event: PluginEvent) => boolean

export interface NewTask {
  kind: ChannelTaskKind
  repo: string
  branch: string | null
  pr: number | null
  sessionId: string | null
  content: string
  meta: TaskMeta
}

export interface PermissionInput {
  requestId: string
  toolName: string
  description: string
  inputPreview: string
}

export interface RegistryOptions {
  now?: () => number
  /** How long a disconnected session stays listed (and keeps queued tasks) waiting for the plugin to reconnect. */
  expiryMs?: number
  /** How long finished tasks stay visible. */
  taskTtlMs?: number
  /** Unanswered permission prompts are marked expired after this long. */
  permissionTtlMs?: number
  maxQueued?: number
  maxTasks?: number
  heartbeatMs?: number
}

interface SessionEntry {
  view: ChannelSessionView
  owner: ChannelOwner
  sink: PluginSink | null
  queue: { taskId: string; event: PluginEvent }[]
}

const STATE_ORDER: Record<ChannelTaskState, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  acknowledged: 3,
  working: 4,
  done: 5,
  failed: 5,
}

const sameOwner = (a: ChannelOwner, b: ChannelOwner) => (a.grantId || b.grantId ? a.grantId === b.grantId : a.tokenId === b.tokenId)

export type DecideResult = 'ok' | 'not_found' | 'decided' | 'disconnected'

/**
 * Connected Claude Code channel sessions, the tasks sent to them and their permission prompts. All in
 * memory: a server restart drops them, and the plugins reconnect and register again.
 */
export function createChannelRegistry({
  now = Date.now,
  expiryMs = 60_000,
  taskTtlMs = 6 * 60 * 60_000,
  permissionTtlMs = 10 * 60_000,
  maxQueued = 20,
  maxTasks = 200,
  heartbeatMs = 15_000,
}: RegistryOptions = {}) {
  const sessions = new Map<string, SessionEntry>()
  const tasks = new Map<string, ChannelTaskView>()
  const permissions = new Map<string, PermissionView>()
  const listeners = new Set<(state: ChannelState) => void>()

  const permissionKey = (channelId: string, requestId: string) => `${channelId}:${requestId}`

  const snapshot = (): ChannelState => ({
    sessions: [...sessions.values()].map((s) => ({ ...s.view })).sort((a, b) => b.connectedAt - a.connectedAt),
    tasks: [...tasks.values()].map((t) => ({ ...t })).sort((a, b) => b.createdAt - a.createdAt),
    permissions: [...permissions.values()].map((p) => ({ ...p })).sort((a, b) => b.createdAt - a.createdAt),
  })

  const changed = () => {
    if (listeners.size === 0) return
    const state = snapshot()
    for (const listener of listeners) listener(state)
  }

  const setTaskState = (task: ChannelTaskView, state: ChannelTaskState, message?: string | null) => {
    if (isFinished(task.state)) return false
    if (STATE_ORDER[state] < STATE_ORDER[task.state]) return false
    task.state = state
    if (message !== undefined && message !== null) task.message = message
    task.updatedAt = now()
    return true
  }

  /** Writes to the plugin; a failed write means the stream is gone. */
  const write = (entry: SessionEntry, event: PluginEvent): boolean => {
    if (!entry.sink) return false
    if (entry.sink(event)) {
      entry.view.lastSeenAt = now()
      return true
    }
    entry.sink = null
    entry.view.connected = false
    return false
  }

  const owned = (id: string, owner: ChannelOwner): SessionEntry | null => {
    const entry = sessions.get(id)
    return entry && sameOwner(entry.owner, owner) ? entry : null
  }

  const pruneTasks = () => {
    const at = now()
    for (const [id, task] of tasks) {
      if (at - task.updatedAt > taskTtlMs) tasks.delete(id)
    }
    if (tasks.size <= maxTasks) return
    const oldest = [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt)
    for (const task of oldest.slice(0, tasks.size - maxTasks)) tasks.delete(task.id)
  }

  return {
    heartbeatMs,

    canConnect(id: string, owner: ChannelOwner): boolean {
      const existing = sessions.get(id)
      return !existing || sameOwner(existing.owner, owner)
    },

    /**
     * Registers (or re-registers) a plugin connection. A session id already held by a different token is
     * refused, so one token cannot take over another's session.
     */
    connect(registration: Registration, owner: ChannelOwner, sink: PluginSink): 'ok' | 'conflict' {
      const at = now()
      const existing = sessions.get(registration.id)
      if (existing && !sameOwner(existing.owner, owner)) return 'conflict'
      const view: ChannelSessionView = {
        ...registration,
        tokenName: owner.tokenName,
        connected: true,
        connectedAt: existing?.view.connectedAt ?? at,
        lastSeenAt: at,
      }
      const entry: SessionEntry = existing ?? { view, owner, sink, queue: [] }
      Object.assign(entry, { view, owner, sink })
      sessions.set(registration.id, entry)
      write(entry, { event: 'ready', data: { id: registration.id, heartbeatMs } })
      const queued = entry.queue.splice(0)
      for (const item of queued) {
        const task = tasks.get(item.taskId)
        if (!task || isFinished(task.state)) continue
        if (write(entry, item.event)) setTaskState(task, 'sent')
        else entry.queue.push(item)
      }
      changed()
      return 'ok'
    },

    /** The stream closed. Only the current stream can mark the session disconnected. */
    disconnect(id: string, sink: PluginSink) {
      const entry = sessions.get(id)
      if (!entry || entry.sink !== sink) return
      entry.sink = null
      entry.view.connected = false
      entry.view.lastSeenAt = now()
      changed()
    },

    /** The plugin is shutting down. */
    remove(id: string, owner: ChannelOwner): boolean {
      if (!owned(id, owner)) return false
      sessions.delete(id)
      changed()
      return true
    },

    /** Drops every session a revoked token registered. */
    removeOwner(owner: ChannelOwner) {
      let removed = false
      for (const [id, entry] of sessions) {
        if (sameOwner(entry.owner, owner)) {
          sessions.delete(id)
          removed = true
        }
      }
      if (removed) changed()
    },

    update(id: string, owner: ChannelOwner, changes: { branch?: string | null; label?: string }): boolean {
      const entry = owned(id, owner)
      if (!entry) return false
      if (changes.branch !== undefined) entry.view.branch = changes.branch
      if (changes.label !== undefined) entry.view.label = changes.label
      entry.view.lastSeenAt = now()
      changed()
      return true
    },

    /** Sends a task, or queues it while the plugin reconnects. */
    sendTask(id: string, input: NewTask): ChannelTaskView | 'not_found' | 'queue_full' {
      const entry = sessions.get(id)
      if (!entry) return 'not_found'
      if (!entry.sink && entry.queue.length >= maxQueued) return 'queue_full'
      const at = now()
      const task: ChannelTaskView = {
        id: randomUUID(),
        channelId: id,
        kind: input.kind,
        repo: input.repo,
        branch: input.branch,
        pr: input.pr,
        sessionId: input.sessionId,
        state: 'queued',
        message: null,
        createdAt: at,
        updatedAt: at,
      }
      tasks.set(task.id, task)
      pruneTasks()
      const event: PluginEvent = { event: 'task', data: { id: task.id, content: input.content, meta: { ...input.meta, task_id: task.id } } }
      if (write(entry, event)) setTaskState(task, 'sent')
      else entry.queue.push({ taskId: task.id, event })
      changed()
      return { ...task }
    },

    /** The plugin handed the task to Claude Code. */
    delivered(id: string, owner: ChannelOwner, taskId: string): boolean {
      const entry = owned(id, owner)
      const task = tasks.get(taskId)
      if (!entry || !task || task.channelId !== id) return false
      entry.view.lastSeenAt = now()
      if (setTaskState(task, 'delivered')) changed()
      return true
    },

    /** Claude reported progress through the plugin's tool. */
    report(id: string, owner: ChannelOwner, taskId: string, state: ReportedState, message: string | null): boolean {
      const entry = owned(id, owner)
      const task = tasks.get(taskId)
      if (!entry || !task || task.channelId !== id) return false
      entry.view.lastSeenAt = now()
      if (setTaskState(task, state, message)) changed()
      return true
    },

    permissionRequest(id: string, owner: ChannelOwner, input: PermissionInput): boolean {
      const entry = owned(id, owner)
      if (!entry) return false
      entry.view.lastSeenAt = now()
      const active = [...tasks.values()]
        .filter((t) => t.channelId === id && !isFinished(t.state))
        .sort((a, b) => b.createdAt - a.createdAt)[0]
      permissions.set(permissionKey(id, input.requestId), {
        channelId: id,
        requestId: input.requestId,
        taskId: active?.id ?? null,
        toolName: input.toolName,
        description: input.description,
        inputPreview: input.inputPreview,
        state: 'pending',
        createdAt: now(),
        decidedAt: null,
      })
      changed()
      return true
    },

    /** Relays the owner's answer to a pending permission prompt. */
    decide(id: string, requestId: string, behavior: PermissionBehavior): DecideResult {
      const entry = sessions.get(id)
      const request = permissions.get(permissionKey(id, requestId))
      if (!entry || !request) return 'not_found'
      if (request.state !== 'pending') return 'decided'
      if (!write(entry, { event: 'verdict', data: { request_id: requestId, behavior } })) {
        changed()
        return 'disconnected'
      }
      request.state = behavior
      request.decidedAt = now()
      changed()
      return 'ok'
    },

    /** Writes a heartbeat; false when the stream is gone. */
    ping(id: string, sink: PluginSink): boolean {
      const entry = sessions.get(id)
      if (!entry || entry.sink !== sink) return false
      const ok = write(entry, { event: 'ping', data: {} })
      if (!ok) changed()
      return ok
    },

    /** Forgets sessions gone longer than the expiry, old tasks, and stale permission prompts. */
    sweep() {
      const at = now()
      let dirty = false
      for (const [id, entry] of sessions) {
        if (!entry.view.connected && at - entry.view.lastSeenAt > expiryMs) {
          sessions.delete(id)
          for (const item of entry.queue) {
            const task = tasks.get(item.taskId)
            if (task) setTaskState(task, 'failed', 'The Claude Code session disconnected before the task was delivered.')
          }
          dirty = true
        }
      }
      for (const [key, request] of permissions) {
        if (request.state === 'pending' && (at - request.createdAt > permissionTtlMs || !sessions.has(request.channelId))) {
          request.state = 'expired'
          request.decidedAt = at
          dirty = true
        }
        if (request.state !== 'pending' && at - (request.decidedAt ?? request.createdAt) > permissionTtlMs) {
          permissions.delete(key)
          dirty = true
        }
      }
      const before = tasks.size
      pruneTasks()
      if (dirty || tasks.size !== before) changed()
    },

    state: snapshot,

    subscribe(listener: (state: ChannelState) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export type ChannelRegistry = ReturnType<typeof createChannelRegistry>
