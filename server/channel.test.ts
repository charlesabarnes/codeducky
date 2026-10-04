import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ChannelState } from '../shared/channel'
import { createChannelRegistry, type ChannelOwner, type PluginEvent, type Registration } from './channel/registry'
import { login, makeApp, request } from './testing'

const registration = (overrides: Partial<Registration> = {}): Registration => ({
  id: 'plugin-session-0001',
  label: 'invoice-service on laptop',
  cwd: '/Users/me/src/invoice-service',
  repo: 'acme/invoice-service',
  branch: 'feature/tax',
  hostname: 'laptop',
  pluginVersion: '0.1.0',
  ...overrides,
})

const owner: ChannelOwner = { tokenId: 't1', grantId: null, tokenName: 'Claude channel' }

function recorder() {
  const events: PluginEvent[] = []
  let open = true
  const sink = (event: PluginEvent) => {
    if (!open) return false
    events.push(event)
    return true
  }
  return { events, sink, close: () => (open = false) }
}

describe('channel registry', () => {
  let clock = 1_000
  const now = () => clock
  beforeEach(() => (clock = 1_000))

  it('registers a session, sends a task and tracks its state', () => {
    const registry = createChannelRegistry({ now })
    const plugin = recorder()
    expect(registry.connect(registration(), owner, plugin.sink)).toBe('ok')
    expect(plugin.events[0]).toEqual({ event: 'ready', data: { id: 'plugin-session-0001', heartbeatMs: 15_000 } })

    const task = registry.sendTask('plugin-session-0001', {
      kind: 'review',
      repo: 'acme/invoice-service',
      branch: 'feature/tax',
      pr: null,
      sessionId: 's1',
      content: 'Review it',
      meta: { kind: 'review' },
    })
    if (typeof task === 'string') throw new Error(task)
    expect(task.state).toBe('sent')
    expect(plugin.events[1]).toEqual({ event: 'task', data: { id: task.id, content: 'Review it', meta: { kind: 'review', task_id: task.id } } })

    expect(registry.delivered('plugin-session-0001', owner, task.id)).toBe(true)
    expect(registry.report('plugin-session-0001', owner, task.id, 'working', 'Reading the diff')).toBe(true)
    // Out-of-order reports never move a task backwards.
    registry.delivered('plugin-session-0001', owner, task.id)
    expect(registry.state().tasks[0]).toMatchObject({ state: 'working', message: 'Reading the diff' })
    registry.report('plugin-session-0001', owner, task.id, 'done', 'Added 2 notes')
    registry.report('plugin-session-0001', owner, task.id, 'working', 'late')
    expect(registry.state().tasks[0]).toMatchObject({ state: 'done', message: 'Added 2 notes' })
  })

  it('refuses a session id held by another token, but lets an OAuth grant reconnect with a new token', () => {
    const registry = createChannelRegistry({ now })
    registry.connect(registration(), owner, recorder().sink)
    const other = { tokenId: 't2', grantId: null, tokenName: 'Other' }
    expect(registry.connect(registration(), other, recorder().sink)).toBe('conflict')
    expect(registry.report('plugin-session-0001', other, 'x', 'done', null)).toBe(false)
    expect(registry.remove('plugin-session-0001', other)).toBe(false)

    const oauth = { tokenId: 'a1', grantId: 'g1', tokenName: 'Claude Code' }
    registry.connect(registration({ id: 'plugin-session-0002' }), oauth, recorder().sink)
    expect(registry.connect(registration({ id: 'plugin-session-0002' }), { ...oauth, tokenId: 'a2' }, recorder().sink)).toBe('ok')
  })

  it('queues tasks while the plugin reconnects, then expires the session and fails what was queued', () => {
    const registry = createChannelRegistry({ now, expiryMs: 60_000 })
    const first = recorder()
    registry.connect(registration(), owner, first.sink)
    registry.disconnect('plugin-session-0001', first.sink)
    expect(registry.state().sessions[0]!.connected).toBe(false)

    const queued = registry.sendTask('plugin-session-0001', { kind: 'fix', repo: 'acme/invoice-service', branch: 'b', pr: null, sessionId: null, content: 'Fix', meta: {} })
    if (typeof queued === 'string') throw new Error(queued)
    expect(queued.state).toBe('queued')

    clock += 30_000
    const second = recorder()
    registry.connect(registration(), owner, second.sink)
    expect(second.events.map((e) => e.event)).toEqual(['ready', 'task'])
    expect(registry.state().tasks[0]!.state).toBe('sent')

    registry.disconnect('plugin-session-0001', second.sink)
    const lost = registry.sendTask('plugin-session-0001', { kind: 'fix', repo: 'acme/invoice-service', branch: 'b', pr: null, sessionId: null, content: 'Again', meta: {} })
    if (typeof lost === 'string') throw new Error(lost)
    clock += 61_000
    registry.sweep()
    expect(registry.state().sessions).toEqual([])
    expect(registry.state().tasks.find((t) => t.id === lost.id)).toMatchObject({ state: 'failed', message: 'The Claude Code session ended before the task was delivered.' })
    expect(registry.sendTask('plugin-session-0001', { kind: 'fix', repo: 'r/r', branch: 'b', pr: null, sessionId: null, content: '', meta: {} })).toBe('not_found')
  })

  it('fails unfinished tasks and expires prompts when the plugin unregisters', () => {
    const registry = createChannelRegistry({ now })
    registry.connect(registration(), owner, recorder().sink)
    const task = registry.sendTask('plugin-session-0001', { kind: 'fix', repo: 'acme/invoice-service', branch: 'b', pr: null, sessionId: null, content: 'Fix', meta: {} })
    if (typeof task === 'string') throw new Error(task)
    registry.report('plugin-session-0001', owner, task.id, 'acknowledged', null)
    registry.permissionRequest('plugin-session-0001', owner, { requestId: 'abcde', toolName: 'Edit', description: '', inputPreview: '' })
    expect(registry.remove('plugin-session-0001', owner)).toBe(true)
    expect(registry.state().tasks[0]).toMatchObject({ state: 'failed', message: 'The Claude Code session ended before reporting done.' })
    expect(registry.state().permissions[0]!.state).toBe('expired')
  })

  it('a stale stream closing does not disconnect the newer one', () => {
    const registry = createChannelRegistry({ now })
    const first = recorder()
    const second = recorder()
    registry.connect(registration(), owner, first.sink)
    registry.connect(registration(), owner, second.sink)
    registry.disconnect('plugin-session-0001', first.sink)
    expect(registry.state().sessions[0]!.connected).toBe(true)
    expect(registry.ping('plugin-session-0001', first.sink)).toBe(false)
    expect(registry.ping('plugin-session-0001', second.sink)).toBe(true)
  })

  it('marks a session disconnected when a write fails', () => {
    const registry = createChannelRegistry({ now })
    const plugin = recorder()
    registry.connect(registration(), owner, plugin.sink)
    plugin.close()
    expect(registry.ping('plugin-session-0001', plugin.sink)).toBe(false)
    expect(registry.state().sessions[0]!.connected).toBe(false)
  })

  it('relays a permission verdict once, and expires unanswered prompts', () => {
    const registry = createChannelRegistry({ now, permissionTtlMs: 600_000 })
    const plugin = recorder()
    registry.connect(registration(), owner, plugin.sink)
    const task = registry.sendTask('plugin-session-0001', { kind: 'review', repo: 'acme/invoice-service', branch: 'b', pr: null, sessionId: null, content: 'x', meta: {} })
    if (typeof task === 'string') throw new Error(task)
    registry.permissionRequest('plugin-session-0001', owner, { requestId: 'abcde', toolName: 'Bash', description: 'List files', inputPreview: '{"command":"ls"}' })
    expect(registry.state().permissions[0]).toMatchObject({ requestId: 'abcde', taskId: task.id, state: 'pending' })

    expect(registry.decide('plugin-session-0001', 'zzzzz', 'allow')).toBe('not_found')
    expect(registry.decide('plugin-session-0001', 'abcde', 'deny')).toBe('ok')
    expect(plugin.events.at(-1)).toEqual({ event: 'verdict', data: { request_id: 'abcde', behavior: 'deny' } })
    expect(registry.decide('plugin-session-0001', 'abcde', 'allow')).toBe('decided')

    registry.permissionRequest('plugin-session-0001', owner, { requestId: 'fghij', toolName: 'Write', description: '', inputPreview: '' })
    clock += 600_001
    registry.sweep()
    expect(registry.state().permissions.find((p) => p.requestId === 'fghij')!.state).toBe('expired')
  })

  it('notifies subscribers on every change and drops a revoked token\'s sessions', () => {
    const registry = createChannelRegistry({ now })
    const seen: ChannelState[] = []
    const unsubscribe = registry.subscribe((state) => seen.push(state))
    registry.connect(registration(), owner, recorder().sink)
    registry.update('plugin-session-0001', owner, { branch: 'main' })
    expect(seen.at(-1)!.sessions[0]!.branch).toBe('main')
    registry.removeOwner(owner)
    expect(seen.at(-1)!.sessions).toEqual([])
    unsubscribe()
    registry.connect(registration(), owner, recorder().sink)
    expect(seen).toHaveLength(3)
  })
})

/** Reads SSE events off a streaming response as they arrive. */
function sseReader(res: Response) {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return {
    async next(): Promise<{ event: string; data: unknown }> {
      for (;;) {
        const end = buffer.indexOf('\n\n')
        if (end >= 0) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message'
          const data = block
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('\n')
          return { event, data: data ? JSON.parse(data) : null }
        }
        const { value, done } = await reader.read()
        if (done) throw new Error('stream ended')
        buffer += decoder.decode(value, { stream: true })
      }
    },
    close: () => reader.cancel(),
  }
}

describe('channel routes', () => {
  let ctx: ReturnType<typeof makeApp>
  let browser: string
  let pluginToken: string
  let pluginTokenId: string

  beforeEach(async () => {
    ctx = makeApp({ channel: createChannelRegistry({ heartbeatMs: 50 }) })
    browser = await login(ctx.app)
    const res = await request(ctx.app, 'POST', '/api/auth/tokens', { name: 'Claude channel' }, browser)
    const body = (await res.json()) as { token: string; info: { id: string } }
    pluginToken = body.token
    pluginTokenId = body.info.id
  })
  afterEach(() => ctx.cleanup())

  const connect = async (overrides: Partial<Registration> = {}, token = pluginToken) => {
    const res = await request(ctx.app, 'POST', '/api/channel/stream', registration(overrides), token)
    return res
  }

  it('authenticates the plugin with API tokens and the browser with device sessions only', async () => {
    expect((await connect({}, '')).status).toBe(401)
    expect((await connect({}, browser)).status).toBe(403)
    expect((await request(ctx.app, 'GET', '/api/channel/sessions', undefined, pluginToken)).status).toBe(403)
    expect((await request(ctx.app, 'GET', '/api/channel/sessions')).status).toBe(401)
    expect((await request(ctx.app, 'POST', '/api/channel/sessions/x/tasks', { kind: 'review' }, pluginToken)).status).toBe(403)
    expect((await request(ctx.app, 'POST', '/api/channel/sessions/x/events', { type: 'delivered', taskId: crypto.randomUUID() }, browser)).status).toBe(403)
  })

  it('validates registrations, events, tasks and verdicts', async () => {
    expect((await connect({ id: 'short' })).status).toBe(400)
    expect((await connect({ repo: 'not a repo' })).status).toBe(400)
    expect((await connect({ label: 'two\nlines' })).status).toBe(400)
    expect((await connect({ branch: 'x'.repeat(300) })).status).toBe(400)

    const stream = sseReader(await connect())
    await stream.next()
    const post = (path: string, body: unknown, token = browser) => request(ctx.app, 'POST', path, body, token)
    const tasks = '/api/channel/sessions/plugin-session-0001/tasks'
    expect((await post(tasks, { kind: 'deploy', target: { repo: 'acme/invoice-service', branch: 'b' } })).status).toBe(400)
    expect((await post(tasks, { kind: 'review', target: { repo: 'acme/invoice-service' } })).status).toBe(400)
    expect((await post(tasks, { kind: 'custom', target: { repo: 'acme/invoice-service', branch: 'b' }, message: '  ' })).status).toBe(400)
    expect((await post(tasks, { kind: 'custom', target: { repo: 'acme/invoice-service', branch: 'b' }, message: 'x'.repeat(5000) })).status).toBe(400)
    expect((await post('/api/channel/sessions/nope-nope-nope/tasks', { kind: 'review', target: { repo: 'a/b', branch: 'b' } })).status).toBe(404)

    const events = '/api/channel/sessions/plugin-session-0001/events'
    expect((await post(events, { type: 'status', taskId: crypto.randomUUID(), state: 'sleeping' }, pluginToken)).status).toBe(400)
    expect((await post(events, { type: 'permission_request', requestId: 'ABCDE', toolName: 'Bash', description: '', inputPreview: '' }, pluginToken)).status).toBe(400)
    expect((await post(events, { type: 'permission_request', requestId: 'abcdl', toolName: 'Bash', description: '', inputPreview: '' }, pluginToken)).status).toBe(400)
    expect((await post(events, { type: 'status', taskId: crypto.randomUUID(), state: 'done' }, pluginToken)).status).toBe(404)
    expect((await post('/api/channel/sessions/plugin-session-0001/permissions/abcde', { behavior: 'maybe' })).status).toBe(400)
    expect((await post('/api/channel/sessions/plugin-session-0001/permissions/abcde', { behavior: 'allow' })).status).toBe(404)
    await stream.close()
  })

  it('relays a task, its status and a permission prompt between the browser and the plugin', async () => {
    const browserEvents = sseReader(await request(ctx.app, 'GET', '/api/channel/events', undefined, browser))
    expect(await browserEvents.next()).toEqual({ event: 'state', data: { sessions: [], tasks: [], permissions: [] } })

    const plugin = sseReader(await connect())
    expect(await plugin.next()).toEqual({ event: 'ready', data: { id: 'plugin-session-0001', heartbeatMs: 50 } })
    const listed = (await (await request(ctx.app, 'GET', '/api/channel/sessions', undefined, browser)).json()) as ChannelState
    expect(listed.sessions).toMatchObject([{ id: 'plugin-session-0001', repo: 'acme/invoice-service', tokenName: 'Claude channel', connected: true }])

    const sent = await request(
      ctx.app,
      'POST',
      '/api/channel/sessions/plugin-session-0001/tasks',
      { kind: 'review', target: { repo: 'acme/invoice-service', branch: 'feature/tax', sessionId: 'sess-1' } },
      browser,
    )
    expect(sent.status).toBe(200)
    const { task } = (await sent.json()) as { task: { id: string; state: string } }
    expect(task.state).toBe('sent')

    let event = await plugin.next()
    while (event.event === 'ping') event = await plugin.next()
    const data = event.data as { id: string; content: string; meta: Record<string, string> }
    expect(event.event).toBe('task')
    expect(data.id).toBe(task.id)
    expect(data.content).toContain('get_review_context')
    expect(data.content).toContain('add_note')
    expect(data.meta).toEqual({
      kind: 'review',
      repo: 'acme/invoice-service',
      branch: 'feature/tax',
      codeducky_session: 'sess-1',
      session_url: 'http://localhost/sessions/sess-1',
      task_id: task.id,
    })

    const events = '/api/channel/sessions/plugin-session-0001/events'
    expect((await request(ctx.app, 'POST', events, { type: 'delivered', taskId: task.id }, pluginToken)).status).toBe(200)
    expect((await request(ctx.app, 'POST', events, { type: 'status', taskId: task.id, state: 'acknowledged', message: 'On it' }, pluginToken)).status).toBe(200)
    expect(
      (await request(ctx.app, 'POST', events, { type: 'permission_request', requestId: 'qwert', toolName: 'Bash', description: 'Run tests', inputPreview: '{"command":"npm test"}' }, pluginToken)).status,
    ).toBe(200)

    let state = (await browserEvents.next()).data as ChannelState
    while (state === null || state.permissions?.length === 0) state = (await browserEvents.next()).data as ChannelState
    expect(state.tasks[0]).toMatchObject({ id: task.id, state: 'acknowledged', message: 'On it' })
    expect(state.permissions[0]).toMatchObject({ requestId: 'qwert', taskId: task.id, state: 'pending', toolName: 'Bash' })

    expect((await request(ctx.app, 'POST', '/api/channel/sessions/plugin-session-0001/permissions/qwert', { behavior: 'allow' }, browser)).status).toBe(200)
    event = await plugin.next()
    while (event.event === 'ping') event = await plugin.next()
    expect(event).toEqual({ event: 'verdict', data: { request_id: 'qwert', behavior: 'allow' } })
    expect((await request(ctx.app, 'POST', '/api/channel/sessions/plugin-session-0001/permissions/qwert', { behavior: 'deny' }, browser)).status).toBe(409)

    await browserEvents.close()
    await plugin.close()
  })

  it('keeps the session id to the token that registered it', async () => {
    const plugin = sseReader(await connect())
    await plugin.next()
    const res = await request(ctx.app, 'POST', '/api/auth/tokens', { name: 'Another' }, browser)
    const other = ((await res.json()) as { token: string }).token
    expect((await connect({}, other)).status).toBe(409)
    expect((await request(ctx.app, 'DELETE', '/api/channel/sessions/plugin-session-0001', undefined, other)).status).toBe(404)
    expect((await request(ctx.app, 'DELETE', '/api/channel/sessions/plugin-session-0001', undefined, pluginToken)).status).toBe(200)
    await plugin.close()
  })

  it('ends the plugin stream and forgets its sessions when the token is revoked', async () => {
    const plugin = sseReader(await connect())
    await plugin.next()
    expect((await request(ctx.app, 'DELETE', `/api/auth/tokens/${pluginTokenId}`, undefined, browser)).status).toBe(200)
    await expect(
      (async () => {
        for (;;) await plugin.next()
      })(),
    ).rejects.toThrow('stream ended')
    expect(ctx.channel.state().sessions).toEqual([])
  })

  it('marks the session disconnected when the plugin goes away', async () => {
    const plugin = sseReader(await connect())
    await plugin.next()
    await plugin.close()
    for (let i = 0; i < 20 && ctx.channel.state().sessions[0]?.connected; i++) await Bun.sleep(20)
    expect(ctx.channel.state().sessions[0]!.connected).toBe(false)
  })
})
