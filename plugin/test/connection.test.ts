import { describe, expect, it } from 'bun:test'
import { repoFromRemote, readCheckout } from '../src/checkout'
import { resolveConfig } from '../src/config'
import { AUTH_DELAY_MS, backoff, createConnection, type Registration, type Task, type Verdict } from '../src/connection'
import { readSse } from '../src/sse'

const streamOf = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })

describe('config', () => {
  const sources = (env: Record<string, string>, git: string | null = null, keychain: string | null = null) => ({
    env,
    gitUrl: () => git,
    keychainToken: () => keychain,
  })

  it('prefers the environment, then git config and the Keychain', () => {
    expect(resolveConfig(sources({ SKELBERT_URL: 'https://s.example/', SKELBERT_TOKEN: 'env' }, 'https://git.example', 'kc'))).toEqual({
      ok: true,
      config: { url: 'https://s.example', token: 'env' },
    })
    expect(resolveConfig(sources({}, 'https://git.example', 'kc'))).toEqual({ ok: true, config: { url: 'https://git.example', token: 'kc' } })
  })

  it('explains what is missing or wrong', () => {
    expect(resolveConfig(sources({}))).toMatchObject({ ok: false, error: expect.stringContaining('SKELBERT_URL') })
    expect(resolveConfig(sources({ SKELBERT_URL: 'https://s.example' }))).toMatchObject({ ok: false, error: expect.stringContaining('Keychain') })
    expect(resolveConfig(sources({ SKELBERT_URL: 'http://s.example', SKELBERT_TOKEN: 't' }))).toMatchObject({ ok: false, error: expect.stringContaining('https') })
    expect(resolveConfig(sources({ SKELBERT_URL: 'http://localhost:8787', SKELBERT_TOKEN: 't' }))).toMatchObject({ ok: true })
    expect(resolveConfig(sources({ SKELBERT_URL: 'nope', SKELBERT_TOKEN: 't' }))).toMatchObject({ ok: false })
  })
})

describe('checkout', () => {
  it('reads owner/name from the usual remote URL shapes', () => {
    expect(repoFromRemote('git@github.com:acme/invoice-service.git')).toBe('acme/invoice-service')
    expect(repoFromRemote('https://github.com/acme/invoice-service')).toBe('acme/invoice-service')
    expect(repoFromRemote('ssh://git@github.com/acme/app.js.git')).toBe('acme/app.js')
    expect(repoFromRemote(null)).toBeNull()
    expect(repoFromRemote('not a remote')).toBeNull()
  })

  it('labels the session with the folder and host', () => {
    const git = (args: string[]) =>
      ({ 'rev-parse --show-toplevel': '/src/app', 'remote get-url origin': 'git@github.com:acme/app.git', 'branch --show-current': 'main' })[
        args.join(' ')
      ] ?? null
    expect(readCheckout('/src/app/lib', git, {}, 'laptop.local')).toEqual({
      cwd: '/src/app',
      repo: 'acme/app',
      branch: 'main',
      hostname: 'laptop',
      label: 'app on laptop',
    })
    expect(readCheckout('/tmp', () => null, { SKELBERT_CHANNEL_LABEL: 'scratch' }, 'h').label).toBe('scratch')
  })
})

describe('sse', () => {
  it('parses events split across chunks, multi-line data and comments', async () => {
    const events = []
    for await (const event of readSse(streamOf(': hi\n\nevent: ready\ndata: {"a"', ':1}\n\nevent: task\r\ndata: x\r\ndata: y\r\n\r\n'))) events.push(event)
    expect(events).toEqual([
      { event: 'ready', data: '{"a":1}' },
      { event: 'task', data: 'x\ny' },
    ])
  })
})

describe('connection', () => {
  const registration: Registration = {
    id: 'session-1234',
    label: 'app on laptop',
    cwd: '/src/app',
    repo: 'acme/app',
    branch: 'main',
    hostname: 'laptop',
    pluginVersion: '0.1.0',
  }

  it('backs off exponentially with jitter, capped at 30 seconds', () => {
    expect(backoff(0, () => 0.5)).toBe(1000)
    expect(backoff(3, () => 0.5)).toBe(8000)
    expect(backoff(10, () => 0.5)).toBe(30_000)
    expect(backoff(0, () => 0)).toBe(800)
  })

  it('registers, delivers tasks and verdicts, reconnects after the stream ends, and backs off on auth errors', async () => {
    const requests: { url: string; method: string; body: unknown; auth: string | null }[] = []
    const responses: (() => Response)[] = [
      () =>
        new Response(
          streamOf(
            'event: ready\ndata: {"id":"session-1234","heartbeatMs":15000}\n\n',
            'event: task\ndata: {"id":"t1","content":"Review","meta":{"kind":"review"}}\n\n',
            'event: task\ndata: {"broken":true}\n\n',
            'event: verdict\ndata: {"request_id":"abcde","behavior":"deny"}\n\n',
          ),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      () => new Response('{"error":"unauthorized"}', { status: 401 }),
      () => new Response(null, { status: 500 }),
    ]
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
        auth: new Headers(init?.headers).get('authorization'),
      })
      if (init?.method === 'DELETE' || String(input).endsWith('/events')) return new Response('{"ok":true}')
      return (responses.shift() ?? (() => new Response(null, { status: 503 })))()
    }) as typeof fetch

    const tasks: Task[] = []
    const verdicts: Verdict[] = []
    const delays: number[] = []
    const connection: ReturnType<typeof createConnection> = createConnection({
      config: { url: 'https://s.example', token: 'tok' },
      registration: () => registration,
      onTask: async (task) => void tasks.push(task),
      onVerdict: async (verdict) => void verdicts.push(verdict),
      log: () => undefined,
      fetch: fetchImpl,
      random: () => 0.5,
      sleep: async (ms) => {
        delays.push(ms)
        if (delays.length === 3) void connection.stop()
      },
    })
    await connection.start()

    expect(tasks).toEqual([{ id: 't1', content: 'Review', meta: { kind: 'review' } }])
    expect(verdicts).toEqual([{ request_id: 'abcde', behavior: 'deny' }])
    // After a session that reached "ready" the backoff starts over; a 401 waits a minute; the 500 is the second failure.
    expect(delays).toEqual([1000, AUTH_DELAY_MS, 2000])
    const streams = requests.filter((r) => r.url.endsWith('/api/channel/stream'))
    expect(streams.length).toBeGreaterThanOrEqual(3)
    expect(streams[0]).toEqual({ url: 'https://s.example/api/channel/stream', method: 'POST', body: registration, auth: 'Bearer tok' })
    expect(requests.at(-1)).toMatchObject({ url: 'https://s.example/api/channel/sessions/session-1234', method: 'DELETE' })

    expect(await connection.send({ type: 'delivered', taskId: 't1' })).toBe(true)
    expect(requests.at(-1)).toMatchObject({ url: 'https://s.example/api/channel/sessions/session-1234/events', body: { type: 'delivered', taskId: 't1' } })
  })
})
