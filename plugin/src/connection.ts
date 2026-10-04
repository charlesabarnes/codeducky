import { z } from 'zod'
import type { ChannelConfig } from './config'
import { readSse } from './sse'

/** What the plugin tells the server about this Claude Code session. */
export interface Registration {
  id: string
  label: string
  cwd: string
  repo: string | null
  branch: string | null
  hostname: string
  pluginVersion: string
}

const taskSchema = z.object({ id: z.string().min(1), content: z.string(), meta: z.record(z.string(), z.string()) })
const verdictSchema = z.object({ request_id: z.string().regex(/^[a-km-z]{5}$/), behavior: z.enum(['allow', 'deny']) })
const readySchema = z.object({ id: z.string(), heartbeatMs: z.number().int().positive() })

export type Task = z.infer<typeof taskSchema>
export type Verdict = z.infer<typeof verdictSchema>

export type ServerEvent =
  | { type: 'delivered'; taskId: string }
  | { type: 'status'; taskId: string; state: 'acknowledged' | 'working' | 'done' | 'failed'; message?: string }
  | { type: 'permission_request'; requestId: string; toolName: string; description: string; inputPreview: string }
  | { type: 'update'; branch?: string | null; label?: string }

export interface ConnectionOptions {
  config: ChannelConfig
  /** Read on every (re)connect, so a branch switch is picked up. */
  registration: () => Registration
  onTask: (task: Task) => Promise<void>
  onVerdict: (verdict: Verdict) => Promise<void>
  log: (message: string) => void
  fetch?: typeof fetch
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  random?: () => number
}

export const BASE_DELAY_MS = 1000
export const MAX_DELAY_MS = 30_000
/** After a 401 or 403 the token is wrong or revoked; retry slowly in case it is replaced. */
export const AUTH_DELAY_MS = 60_000
const DEFAULT_HEARTBEAT_MS = 15_000

/** Exponential backoff with ±20% jitter. */
export const backoff = (attempt: number, random: () => number = Math.random) =>
  Math.round(Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt) * (0.8 + 0.4 * random()))

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })

/**
 * The outbound connection to the Skelbert server: POST /api/channel/stream registers this session and
 * holds an SSE stream of tasks and permission verdicts. Reconnects with backoff, and gives up on a
 * stream that has been silent for three heartbeats.
 */
export function createConnection({
  config,
  registration,
  onTask,
  onVerdict,
  log,
  fetch: fetchImpl = fetch,
  sleep = abortableSleep,
  random = Math.random,
}: ConnectionOptions) {
  const stopped = new AbortController()
  let current: AbortController | null = null
  let connected = false
  let loop: Promise<void> | null = null
  let sessionId: string | null = null
  const headers = { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' }

  async function once(): Promise<'ok' | 'auth' | 'error'> {
    const abort = new AbortController()
    current = abort
    let watchdog: ReturnType<typeof setTimeout> | undefined
    let heartbeat = DEFAULT_HEARTBEAT_MS
    const kick = () => {
      clearTimeout(watchdog)
      watchdog = setTimeout(() => abort.abort(), heartbeat * 3)
    }
    let ready = false
    try {
      const body = registration()
      sessionId = body.id
      const res = await fetchImpl(`${config.url}/api/channel/stream`, {
        method: 'POST',
        headers: { ...headers, Accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: abort.signal,
      })
      if (res.status === 401 || res.status === 403) {
        log(`Skelbert refused the token (HTTP ${res.status}). Check SKELBERT_TOKEN or the Keychain item "skelbert".`)
        await res.body?.cancel()
        return 'auth'
      }
      if (!res.ok || !res.body) {
        log(`Skelbert answered HTTP ${res.status} to the channel registration.`)
        await res.body?.cancel()
        return 'error'
      }
      kick()
      for await (const message of readSse(res.body)) {
        kick()
        let data: unknown
        try {
          data = message.data ? JSON.parse(message.data) : null
        } catch {
          continue
        }
        if (message.event === 'ready') {
          const parsed = readySchema.safeParse(data)
          if (parsed.success) heartbeat = parsed.data.heartbeatMs
          ready = connected = true
          kick()
          log(`Connected to ${config.url} as "${body.label}".`)
        } else if (message.event === 'task') {
          const parsed = taskSchema.safeParse(data)
          if (parsed.success) await onTask(parsed.data).catch((error: unknown) => log(`Could not deliver a task: ${String(error)}`))
        } else if (message.event === 'verdict') {
          const parsed = verdictSchema.safeParse(data)
          if (parsed.success) await onVerdict(parsed.data).catch((error: unknown) => log(`Could not relay a verdict: ${String(error)}`))
        }
      }
      if (!stopped.signal.aborted) log('The Skelbert stream ended; reconnecting.')
      return ready ? 'ok' : 'error'
    } catch (error) {
      if (!stopped.signal.aborted) log(`Lost the Skelbert connection: ${error instanceof Error ? error.message : String(error)}`)
      return ready ? 'ok' : 'error'
    } finally {
      clearTimeout(watchdog)
      connected = false
      current = null
    }
  }

  async function run() {
    let attempt = 0
    while (!stopped.signal.aborted) {
      const result = await once()
      if (stopped.signal.aborted) break
      if (result === 'ok') attempt = 0
      const delay = result === 'auth' ? AUTH_DELAY_MS : backoff(attempt++, random)
      await sleep(delay, stopped.signal)
    }
  }

  return {
    start() {
      loop ??= run()
      return loop
    },

    get connected() {
      return connected
    },

    /** Sends an event about this session; false when the server did not take it. */
    async send(event: ServerEvent): Promise<boolean> {
      if (!sessionId) return false
      try {
        const res = await fetchImpl(`${config.url}/api/channel/sessions/${encodeURIComponent(sessionId)}/events`, {
          method: 'POST',
          headers,
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(10_000),
        })
        await res.body?.cancel()
        return res.ok
      } catch {
        return false
      }
    },

    /** Closes the stream and unregisters the session (best effort). */
    async stop() {
      stopped.abort()
      current?.abort()
      if (sessionId) {
        await fetchImpl(`${config.url}/api/channel/sessions/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
          headers,
          signal: AbortSignal.timeout(2000),
        }).catch(() => undefined)
      }
      await loop
    },
  }
}

export type Connection = ReturnType<typeof createConnection>
