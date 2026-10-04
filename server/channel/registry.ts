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

/**
 * The access token behind a plugin connection. OAuth tokens rotate, so their grant is what stays the same.
 * Sessions belong to the token's user: every lookup is keyed by user, so ids never collide across users.
 */
export interface ChannelOwner {
  userId: string
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
  /** Tasks kept per user. */
  maxTasks?: number
  /** Sessions listed per user, connected or waiting to reconnect. */
  maxSessions?: number
  heartbeatMs?: number
}

interface SessionEntry {
  view: ChannelSessionView
  owner: ChannelOwner
  sink: PluginSink | null
  queue: { taskId: string; event: PluginEvent }[]
}

interface TaskEntry {
  userId: string
  view: ChannelTaskView
}

interface PermissionEntry {
  userId: string
  view: PermissionView
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

const sameOwner = (a: ChannelOwner, b: ChannelOwner) =>
  a.userId === b.userId && (a.grantId || b.grantId ? a.grantId === b.grantId : a.tokenId === b.tokenId)

const sessionKey = (userId: string, id: string) => `${userId}\u0000${id}`

const byNewest = <T extends { createdAt: number }>(a: T, b: T) => b.createdAt - a.createdAt

export type ConnectResult = 'ok' | 'conflict' | 'limit'
export type DecideResult = 'ok' | 'not_found' | 'decided' | 'disconnected'

/**
 * Connected Claude Code channel sessions, the tasks sent to them and their permission prompts, kept apart
 * per user. All in memory: a server restart drops them, and the plugins reconnect and register again.
 */
export function createChannelRegistry({
  now = Date.now,
  expiryMs = 60_000,
  taskTtlMs = 6 * 60 * 60_000,
  permissionTtlMs = 10 * 60_000,
  maxQueued = 20,
  maxTasks = 200,
  maxSessions = 10,
  heartbeatMs = 15_000,
}: RegistryOptions = {}) {
  const sessions = new Map<string, SessionEntry>()
  const tasks = new Map<string, TaskEntry>()
  const permissions = new Map<string, PermissionEntry>()
  const listeners = new Map<string, Set<(state: ChannelState) => void>>()

  const permissionKey = (userId: string, channelId: string, requestId: string) => `${sessionKey(userId, channelId)}\u0000${requestId}`

  const snapshot = (userId: string): ChannelState => ({
    sessions: [...sessions.values()]
      .filter((s) => s.owner.userId === userId)
      .map((s) => ({ ...s.view }))
      .sort((a, b) => b.connectedAt - a.connectedAt),
    tasks: [...tasks.values()].filter((t) => t.userId === userId).map((t) => ({ ...t.view })).sort(byNewest),
    permissions: [...permissions.values()].filter((p) => p.userId === userId).map((p) => ({ ...p.view })).sort(byNewest),
  })

  const changed = (userId: string) => {
    const subscribed = listeners.get(userId)
    if (!subscribed?.size) return
    const state = snapshot(userId)
    for (const listener of subscribed) listener(state)
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
    const entry = sessions.get(sessionKey(owner.userId, id))
    return entry && sameOwner(entry.owner, owner) ? entry : null
  }

  const taskOf = (userId: string, channelId: string, taskId: string): ChannelTaskView | null => {
    const task = tasks.get(taskId)
    return task && task.userId === userId && task.view.channelId === channelId ? task.view : null
  }

  const admit = (id: string, owner: ChannelOwner): ConnectResult => {
    const existing = sessions.get(sessionKey(owner.userId, id))
    if (existing) return sameOwner(existing.owner, owner) ? 'ok' : 'conflict'
    let count = 0
    for (const entry of sessions.values()) if (entry.owner.userId === owner.userId) count++
    return count >= maxSessions ? 'limit' : 'ok'
  }

  /** A session is gone: its unfinished tasks can no longer finish, and its prompts can no longer be answered. */
  const forget = (userId: string, id: string) => {
    sessions.delete(sessionKey(userId, id))
    for (const { userId: taskUser, view: task } of tasks.values()) {
      if (taskUser !== userId || task.channelId !== id || isFinished(task.state)) continue
      const delivered = STATE_ORDER[task.state] >= STATE_ORDER.delivered
      setTaskState(task, 'failed', delivered ? 'The Claude Code session ended before reporting done.' : 'The Claude Code session ended before the task was delivered.')
    }
    for (const { userId: requestUser, view: request } of permissions.values()) {
      if (requestUser === userId && request.channelId === id && request.state === 'pending') {
        request.state = 'expired'
        request.decidedAt = now()
      }
    }
  }

  /** Keeps a user's newest tasks, up to the cap. */
  const capTasks = (userId: string) => {
    const own = [...tasks.values()].filter((t) => t.userId === userId)
    if (own.length <= maxTasks) return
    own.sort((a, b) => a.view.createdAt - b.view.createdAt)
    for (const task of own.slice(0, own.length - maxTasks)) tasks.delete(task.view.id)
  }

  return {
    heartbeatMs,

    canConnect: admit,

    /**
     * Registers (or re-registers) a plugin connection. Session ids are per user, so another user's session
     * with the same id is never touched. Within a user, an id held by a different token is refused, so one
     * token cannot take over another's session, and a user has at most `maxSessions` sessions.
     */
    connect(registration: Registration, owner: ChannelOwner, sink: PluginSink): ConnectResult {
      const admitted = admit(registration.id, owner)
      if (admitted !== 'ok') return admitted
      const at = now()
      const key = sessionKey(owner.userId, registration.id)
      const existing = sessions.get(key)
      const view: ChannelSessionView = {
        ...registration,
        tokenName: owner.tokenName,
        connected: true,
        connectedAt: existing?.view.connectedAt ?? at,
        lastSeenAt: at,
      }
      const entry: SessionEntry = existing ?? { view, owner, sink, queue: [] }
      Object.assign(entry, { view, owner, sink })
      sessions.set(key, entry)
      write(entry, { event: 'ready', data: { id: registration.id, heartbeatMs } })
      const queued = entry.queue.splice(0)
      for (const item of queued) {
        const task = taskOf(owner.userId, registration.id, item.taskId)
        if (!task || isFinished(task.state)) continue
        if (write(entry, item.event)) setTaskState(task, 'sent')
        else entry.queue.push(item)
      }
      changed(owner.userId)
      return 'ok'
    },

    /** The stream closed. Only the current stream can mark the session disconnected. */
    disconnect(id: string, owner: ChannelOwner, sink: PluginSink) {
      const entry = sessions.get(sessionKey(owner.userId, id))
      if (!entry || entry.sink !== sink) return
      entry.sink = null
      entry.view.connected = false
      entry.view.lastSeenAt = now()
      changed(owner.userId)
    },

    /** The plugin is shutting down. */
    remove(id: string, owner: ChannelOwner): boolean {
      if (!owned(id, owner)) return false
      forget(owner.userId, id)
      changed(owner.userId)
      return true
    },

    /** Drops every session a revoked token registered. */
    removeOwner(owner: ChannelOwner) {
      let removed = false
      for (const entry of sessions.values()) {
        if (sameOwner(entry.owner, owner)) {
          forget(owner.userId, entry.view.id)
          removed = true
        }
      }
      if (removed) changed(owner.userId)
    },

    /** Drops a disabled or deleted user's sessions, tasks and prompts. Their plugin streams end at the next heartbeat. */
    removeUser(userId: string) {
      for (const [key, entry] of sessions) if (entry.owner.userId === userId) sessions.delete(key)
      for (const [id, task] of tasks) if (task.userId === userId) tasks.delete(id)
      for (const [key, request] of permissions) if (request.userId === userId) permissions.delete(key)
      changed(userId)
    },

    update(id: string, owner: ChannelOwner, changes: { branch?: string | null; label?: string }): boolean {
      const entry = owned(id, owner)
      if (!entry) return false
      if (changes.branch !== undefined) entry.view.branch = changes.branch
      if (changes.label !== undefined) entry.view.label = changes.label
      entry.view.lastSeenAt = now()
      changed(owner.userId)
      return true
    },

    /** Sends a task to one of the user's sessions, or queues it while the plugin reconnects. */
    sendTask(userId: string, id: string, input: NewTask): ChannelTaskView | 'not_found' | 'queue_full' {
      const entry = sessions.get(sessionKey(userId, id))
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
      tasks.set(task.id, { userId, view: task })
      capTasks(userId)
      const event: PluginEvent = { event: 'task', data: { id: task.id, content: input.content, meta: { ...input.meta, task_id: task.id } } }
      if (write(entry, event)) setTaskState(task, 'sent')
      else entry.queue.push({ taskId: task.id, event })
      changed(userId)
      return { ...task }
    },

    /** The plugin handed the task to Claude Code. */
    delivered(id: string, owner: ChannelOwner, taskId: string): boolean {
      const entry = owned(id, owner)
      const task = taskOf(owner.userId, id, taskId)
      if (!entry || !task) return false
      entry.view.lastSeenAt = now()
      if (setTaskState(task, 'delivered')) changed(owner.userId)
      return true
    },

    /** Claude reported progress through the plugin's tool. */
    report(id: string, owner: ChannelOwner, taskId: string, state: ReportedState, message: string | null): boolean {
      const entry = owned(id, owner)
      const task = taskOf(owner.userId, id, taskId)
      if (!entry || !task) return false
      entry.view.lastSeenAt = now()
      if (setTaskState(task, state, message)) changed(owner.userId)
      return true
    },

    permissionRequest(id: string, owner: ChannelOwner, input: PermissionInput): boolean {
      const entry = owned(id, owner)
      if (!entry) return false
      entry.view.lastSeenAt = now()
      const active = [...tasks.values()]
        .filter((t) => t.userId === owner.userId && t.view.channelId === id && !isFinished(t.view.state))
        .map((t) => t.view)
        .sort(byNewest)[0]
      permissions.set(permissionKey(owner.userId, id, input.requestId), {
        userId: owner.userId,
        view: {
          channelId: id,
          requestId: input.requestId,
          taskId: active?.id ?? null,
          toolName: input.toolName,
          description: input.description,
          inputPreview: input.inputPreview,
          state: 'pending',
          createdAt: now(),
          decidedAt: null,
        },
      })
      changed(owner.userId)
      return true
    },

    /** Relays the user's answer to a pending permission prompt in one of their sessions. */
    decide(userId: string, id: string, requestId: string, behavior: PermissionBehavior): DecideResult {
      const entry = sessions.get(sessionKey(userId, id))
      const request = permissions.get(permissionKey(userId, id, requestId))?.view
      if (!entry || !request) return 'not_found'
      if (request.state !== 'pending') return 'decided'
      if (!write(entry, { event: 'verdict', data: { request_id: requestId, behavior } })) {
        changed(userId)
        return 'disconnected'
      }
      request.state = behavior
      request.decidedAt = now()
      changed(userId)
      return 'ok'
    },

    /** Writes a heartbeat; false when the stream is gone. */
    ping(id: string, owner: ChannelOwner, sink: PluginSink): boolean {
      const entry = sessions.get(sessionKey(owner.userId, id))
      if (!entry || entry.sink !== sink) return false
      const ok = write(entry, { event: 'ping', data: {} })
      if (!ok) changed(owner.userId)
      return ok
    },

    /** Forgets sessions gone longer than the expiry, old tasks, and stale permission prompts. */
    sweep() {
      const at = now()
      const dirty = new Set<string>()
      for (const entry of sessions.values()) {
        if (!entry.view.connected && at - entry.view.lastSeenAt > expiryMs) {
          forget(entry.owner.userId, entry.view.id)
          dirty.add(entry.owner.userId)
        }
      }
      for (const [key, { userId, view: request }] of permissions) {
        if (request.state === 'pending' && (at - request.createdAt > permissionTtlMs || !sessions.has(sessionKey(userId, request.channelId)))) {
          request.state = 'expired'
          request.decidedAt = at
          dirty.add(userId)
        }
        if (request.state !== 'pending' && at - (request.decidedAt ?? request.createdAt) > permissionTtlMs) {
          permissions.delete(key)
          dirty.add(userId)
        }
      }
      for (const [id, task] of tasks) {
        if (at - task.view.updatedAt > taskTtlMs) {
          tasks.delete(id)
          dirty.add(task.userId)
        }
      }
      for (const userId of dirty) changed(userId)
    },

    /** One user's sessions, tasks and permission prompts. */
    state: snapshot,

    subscribe(userId: string, listener: (state: ChannelState) => void): () => void {
      const own = listeners.get(userId) ?? new Set()
      listeners.set(userId, own)
      own.add(listener)
      return () => {
        own.delete(listener)
        if (own.size === 0 && listeners.get(userId) === own) listeners.delete(userId)
      }
    },
  }
}

export type ChannelRegistry = ReturnType<typeof createChannelRegistry>
