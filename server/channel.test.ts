import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ChannelState } from '../shared/channel'
import { createChannelRegistry, type ChannelOwner, type PluginEvent, type Registration } from './channel/registry'
import { createUserSession, makeApp, request, sseReader } from './testing'

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

const ALICE = 'user-alice'
const owner: ChannelOwner = { userId: ALICE, tokenId: 't1', grantId: null, tokenName: 'Claude channel' }

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

    const task = registry.sendTask(ALICE, 'plugin-session-0001', {
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
    expect(registry.state(ALICE).tasks[0]).toMatchObject({ state: 'working', message: 'Reading the diff' })
    registry.report('plugin-session-0001', owner, task.id, 'done', 'Added 2 notes')
    registry.report('plugin-session-0001', owner, task.id, 'working', 'late')
    expect(registry.state(ALICE).tasks[0]).toMatchObject({ state: 'done', message: 'Added 2 notes' })
  })

  it('refuses a session id held by another token, but lets an OAuth grant reconnect with a new token', () => {
    const registry = createChannelRegistry({ now })
    registry.connect(registration(), owner, recorder().sink)
    const other = { userId: ALICE, tokenId: 't2', grantId: null, tokenName: 'Other' }
    expect(registry.connect(registration(), other, recorder().sink)).toBe('conflict')
    expect(registry.report('plugin-session-0001', other, 'x', 'done', null)).toBe(false)
    expect(registry.remove('plugin-session-0001', other)).toBe(false)

    const oauth = { userId: ALICE, tokenId: 'a1', grantId: 'g1', tokenName: 'Claude Code' }
    registry.connect(registration({ id: 'plugin-session-0002' }), oauth, recorder().sink)
    expect(registry.connect(registration({ id: 'plugin-session-0002' }), { ...oauth, tokenId: 'a2' }, recorder().sink)).toBe('ok')
  })

  it('queues tasks while the plugin reconnects, then expires the session and fails what was queued', () => {
    const registry = createChannelRegistry({ now, expiryMs: 60_000 })
    const first = recorder()
    registry.connect(registration(), owner, first.sink)
    registry.disconnect('plugin-session-0001', owner, first.sink)
    expect(registry.state(ALICE).sessions[0]!.connected).toBe(false)

    const queued = registry.sendTask(ALICE, 'plugin-session-0001', { kind: 'fix', repo: 'acme/invoice-service', branch: 'b', pr: null, sessionId: null, content: 'Fix', meta: {} })
    if (typeof queued === 'string') throw new Error(queued)
    expect(queued.state).toBe('queued')

    clock += 30_000
    const second = recorder()
    registry.connect(registration(), owner, second.sink)
    expect(second.events.map((e) => e.event)).toEqual(['ready', 'task'])
    expect(registry.state(ALICE).tasks[0]!.state).toBe('sent')

    registry.disconnect('plugin-session-0001', owner, second.sink)
    const lost = registry.sendTask(ALICE, 'plugin-session-0001', { kind: 'fix', repo: 'acme/invoice-service', branch: 'b', pr: null, sessionId: null, content: 'Again', meta: {} })
    if (typeof lost === 'string') throw new Error(lost)
    clock += 61_000
    registry.sweep()
    expect(registry.state(ALICE).sessions).toEqual([])
    expect(registry.state(ALICE).tasks.find((t) => t.id === lost.id)).toMatchObject({ state: 'failed', message: 'The Claude Code session ended before the task was delivered.' })
    expect(registry.sendTask(ALICE, 'plugin-session-0001', { kind: 'fix', repo: 'r/r', branch: 'b', pr: null, sessionId: null, content: '', meta: {} })).toBe('not_found')
  })

  it('fails unfinished tasks and expires prompts when the plugin unregisters', () => {
    const registry = createChannelRegistry({ now })
    registry.connect(registration(), owner, recorder().sink)
    const task = registry.sendTask(ALICE, 'plugin-session-0001', { kind: 'fix', repo: 'acme/invoice-service', branch: 'b', pr: null, sessionId: null, content: 'Fix', meta: {} })
    if (typeof task === 'string') throw new Error(task)
    registry.report('plugin-session-0001', owner, task.id, 'acknowledged', null)
    registry.permissionRequest('plugin-session-0001', owner, { requestId: 'abcde', toolName: 'Edit', description: '', inputPreview: '' })
    expect(registry.remove('plugin-session-0001', owner)).toBe(true)
    expect(registry.state(ALICE).tasks[0]).toMatchObject({ state: 'failed', message: 'The Claude Code session ended before reporting done.' })
    expect(registry.state(ALICE).permissions[0]!.state).toBe('expired')
  })

  it('tells finished-task listeners once per task, whether Claude reported it or the session ended', () => {
    const registry = createChannelRegistry({ now })
    const finished: [string, string, string][] = []
    const stop = registry.onTaskFinished((userId, task) => finished.push([userId, task.id, task.state]))
    registry.connect(registration(), owner, recorder().sink)
    const send = () => {
      const task = registry.sendTask(ALICE, 'plugin-session-0001', { kind: 'fix', repo: 'acme/invoice-service', branch: 'b', pr: null, sessionId: null, content: 'Fix', meta: {} })
      if (typeof task === 'string') throw new Error(task)
      return task.id
    }
    const reported = send()
    registry.report('plugin-session-0001', owner, reported, 'working', null)
    registry.report('plugin-session-0001', owner, reported, 'done', 'ok')
    registry.report('plugin-session-0001', owner, reported, 'failed', 'late')
    const orphaned = send()
    registry.remove('plugin-session-0001', owner)
    expect(finished).toEqual([
      [ALICE, reported, 'done'],
      [ALICE, orphaned, 'failed'],
    ])
    stop()
    registry.connect(registration(), owner, recorder().sink)
    registry.report('plugin-session-0001', owner, send(), 'done', null)
    expect(finished).toHaveLength(2)
  })

  it('a stale stream closing does not disconnect the newer one', () => {
    const registry = createChannelRegistry({ now })
    const first = recorder()
    const second = recorder()
    registry.connect(registration(), owner, first.sink)
    registry.connect(registration(), owner, second.sink)
    registry.disconnect('plugin-session-0001', owner, first.sink)
    expect(registry.state(ALICE).sessions[0]!.connected).toBe(true)
    expect(registry.ping('plugin-session-0001', owner, first.sink)).toBe(false)
    expect(registry.ping('plugin-session-0001', owner, second.sink)).toBe(true)
  })

  it('marks a session disconnected when a write fails', () => {
    const registry = createChannelRegistry({ now })
    const plugin = recorder()
    registry.connect(registration(), owner, plugin.sink)
    plugin.close()
    expect(registry.ping('plugin-session-0001', owner, plugin.sink)).toBe(false)
    expect(registry.state(ALICE).sessions[0]!.connected).toBe(false)
  })

  it('relays a permission verdict once, and expires unanswered prompts', () => {
    const registry = createChannelRegistry({ now, permissionTtlMs: 600_000 })
    const plugin = recorder()
    registry.connect(registration(), owner, plugin.sink)
    const task = registry.sendTask(ALICE, 'plugin-session-0001', { kind: 'review', repo: 'acme/invoice-service', branch: 'b', pr: null, sessionId: null, content: 'x', meta: {} })
    if (typeof task === 'string') throw new Error(task)
    registry.permissionRequest('plugin-session-0001', owner, { requestId: 'abcde', toolName: 'Bash', description: 'List files', inputPreview: '{"command":"ls"}' })
    expect(registry.state(ALICE).permissions[0]).toMatchObject({ requestId: 'abcde', taskId: task.id, state: 'pending' })

    expect(registry.decide(ALICE, 'plugin-session-0001', 'zzzzz', 'allow')).toBe('not_found')
    expect(registry.decide(ALICE, 'plugin-session-0001', 'abcde', 'deny')).toBe('ok')
    expect(plugin.events.at(-1)).toEqual({ event: 'verdict', data: { request_id: 'abcde', behavior: 'deny' } })
    expect(registry.decide(ALICE, 'plugin-session-0001', 'abcde', 'allow')).toBe('decided')

    registry.permissionRequest('plugin-session-0001', owner, { requestId: 'fghij', toolName: 'Write', description: '', inputPreview: '' })
    clock += 600_001
    registry.sweep()
    expect(registry.state(ALICE).permissions.find((p) => p.requestId === 'fghij')!.state).toBe('expired')
  })

  it('notifies subscribers on every change and drops a revoked token\'s sessions', () => {
    const registry = createChannelRegistry({ now })
    const seen: ChannelState[] = []
    const unsubscribe = registry.subscribe(ALICE, (state) => seen.push(state))
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

describe('channel registry across users', () => {
  const BOB = 'user-bob'
  const bob: ChannelOwner = { userId: BOB, tokenId: 't9', grantId: null, tokenName: 'Bob channel' }
  const task = (content: string) => ({ kind: 'fix' as const, repo: 'acme/invoice-service', branch: 'b', pr: null, sessionId: null, content, meta: {} })

  it('keeps the same session id apart per user', () => {
    const registry = createChannelRegistry()
    const alicePlugin = recorder()
    const bobPlugin = recorder()
    expect(registry.connect(registration(), owner, alicePlugin.sink)).toBe('ok')
    expect(registry.canConnect('plugin-session-0001', bob)).toBe('ok')
    expect(registry.connect(registration({ label: 'bob laptop' }), bob, bobPlugin.sink)).toBe('ok')

    expect(registry.state(ALICE).sessions.map((s) => s.label)).toEqual(['invoice-service on laptop'])
    expect(registry.state(BOB).sessions.map((s) => s.label)).toEqual(['bob laptop'])

    const sent = registry.sendTask(BOB, 'plugin-session-0001', task('for bob'))
    if (typeof sent === 'string') throw new Error(sent)
    expect(bobPlugin.events.at(-1)).toMatchObject({ event: 'task', data: { content: 'for bob' } })
    expect(alicePlugin.events.map((e) => e.event)).toEqual(['ready'])
    expect(registry.state(ALICE).tasks).toEqual([])

    expect(registry.delivered('plugin-session-0001', owner, sent.id)).toBe(false)
    expect(registry.report('plugin-session-0001', owner, sent.id, 'done', null)).toBe(false)
    expect(registry.state(BOB).tasks[0]!.state).toBe('sent')

    registry.remove('plugin-session-0001', bob)
    expect(registry.state(ALICE).sessions[0]!.connected).toBe(true)
  })

  it('refuses tasks and verdicts for another user\'s session', () => {
    const registry = createChannelRegistry()
    const plugin = recorder()
    registry.connect(registration(), owner, plugin.sink)
    registry.permissionRequest('plugin-session-0001', owner, { requestId: 'abcde', toolName: 'Bash', description: '', inputPreview: '' })

    expect(registry.sendTask(BOB, 'plugin-session-0001', task('hijack'))).toBe('not_found')
    expect(registry.decide(BOB, 'plugin-session-0001', 'abcde', 'allow')).toBe('not_found')
    expect(registry.permissionRequest('plugin-session-0001', bob, { requestId: 'fghij', toolName: 'Bash', description: '', inputPreview: '' })).toBe(false)
    expect(registry.update('plugin-session-0001', bob, { label: 'taken' })).toBe(false)
    expect(registry.remove('plugin-session-0001', bob)).toBe(false)
    registry.removeOwner({ ...bob, tokenId: 't1' })
    expect(plugin.events.map((e) => e.event)).toEqual(['ready'])
    expect(registry.state(ALICE)).toMatchObject({ sessions: [{ label: 'invoice-service on laptop', connected: true }], tasks: [], permissions: [{ state: 'pending' }] })
    expect(registry.state(BOB)).toEqual({ sessions: [], tasks: [], permissions: [] })
  })

  it('only notifies the user whose state changed', () => {
    const registry = createChannelRegistry()
    const aliceSeen: ChannelState[] = []
    const bobSeen: ChannelState[] = []
    registry.subscribe(ALICE, (state) => aliceSeen.push(state))
    registry.subscribe(BOB, (state) => bobSeen.push(state))
    registry.connect(registration(), owner, recorder().sink)
    registry.sendTask(ALICE, 'plugin-session-0001', task('x'))
    expect(aliceSeen).toHaveLength(2)
    expect(bobSeen).toEqual([])
  })

  it('caps sessions and tasks per user', () => {
    const registry = createChannelRegistry({ maxSessions: 2, maxTasks: 2 })
    registry.connect(registration({ id: 'alice-session-1' }), owner, recorder().sink)
    registry.connect(registration({ id: 'alice-session-2' }), owner, recorder().sink)
    expect(registry.canConnect('alice-session-3', owner)).toBe('limit')
    expect(registry.connect(registration({ id: 'alice-session-3' }), owner, recorder().sink)).toBe('limit')
    expect(registry.connect(registration({ id: 'alice-session-1' }), owner, recorder().sink)).toBe('ok')
    expect(registry.connect(registration({ id: 'bob-session-01' }), bob, recorder().sink)).toBe('ok')

    let clock = 0
    const timed = createChannelRegistry({ maxTasks: 2, now: () => ++clock })
    timed.connect(registration(), owner, recorder().sink)
    timed.connect(registration(), bob, recorder().sink)
    timed.sendTask(BOB, 'plugin-session-0001', task('bob'))
    for (const content of ['a1', 'a2', 'a3']) timed.sendTask(ALICE, 'plugin-session-0001', task(content))
    expect(timed.state(ALICE).tasks).toHaveLength(2)
    expect(timed.state(BOB).tasks).toHaveLength(1)
  })

  it('removeUser drops only that user\'s sessions, tasks and prompts', () => {
    const registry = createChannelRegistry()
    const seen: ChannelState[] = []
    registry.subscribe(ALICE, (state) => seen.push(state))
    const plugin = recorder()
    registry.connect(registration(), owner, plugin.sink)
    registry.sendTask(ALICE, 'plugin-session-0001', task('x'))
    registry.permissionRequest('plugin-session-0001', owner, { requestId: 'abcde', toolName: 'Bash', description: '', inputPreview: '' })
    registry.connect(registration(), bob, recorder().sink)
    registry.sendTask(BOB, 'plugin-session-0001', task('y'))

    registry.removeUser(ALICE)
    expect(registry.state(ALICE)).toEqual({ sessions: [], tasks: [], permissions: [] })
    expect(seen.at(-1)).toEqual({ sessions: [], tasks: [], permissions: [] })
    expect(registry.ping('plugin-session-0001', owner, plugin.sink)).toBe(false)
    expect(registry.state(BOB).sessions).toHaveLength(1)
    expect(registry.state(BOB).tasks).toHaveLength(1)
  })
})

describe('channel routes', () => {
  let ctx: ReturnType<typeof makeApp>
  let browser: string
  let userId: string
  let pluginToken: string
  let pluginTokenId: string

  beforeEach(async () => {
    ctx = makeApp({ channel: createChannelRegistry({ heartbeatMs: 50 }) })
    const alice = createUserSession(ctx.db, 'alice')
    browser = alice.token
    userId = alice.user.id
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
    expect(ctx.channel.state(userId).sessions).toEqual([])
  })

  it('marks the session disconnected when the plugin goes away', async () => {
    const plugin = sseReader(await connect())
    await plugin.next()
    await plugin.close()
    for (let i = 0; i < 20 && ctx.channel.state(userId).sessions[0]?.connected; i++) await Bun.sleep(20)
    expect(ctx.channel.state(userId).sessions[0]!.connected).toBe(false)
  })
})

describe('channel routes across users', () => {
  let ctx: ReturnType<typeof makeApp>
  afterEach(() => ctx.cleanup())

  async function signIn(login: string) {
    const { token: browser, user } = createUserSession(ctx.db, login)
    const res = await request(ctx.app, 'POST', '/api/auth/tokens', { name: `${login} channel` }, browser)
    const { token: plugin } = (await res.json()) as { token: string }
    const connect = (overrides: Partial<Registration> = {}) => request(ctx.app, 'POST', '/api/channel/stream', registration(overrides), plugin)
    return { browser, plugin, userId: user.id, connect }
  }

  it('keeps sessions, tasks and prompts to the user who owns them', async () => {
    ctx = makeApp({ channel: createChannelRegistry({ heartbeatMs: 50 }) })
    const alice = await signIn('alice')
    const bob = await signIn('bob')
    const aliceShared = sseReader(await alice.connect())
    const alicePrivate = sseReader(await alice.connect({ id: 'alice-only-session' }))
    await aliceShared.next()
    await alicePrivate.next()

    const bobShared = await bob.connect({ label: 'bob laptop' })
    expect(bobShared.status).toBe(200)
    const bobStream = sseReader(bobShared)
    expect(await bobStream.next()).toEqual({ event: 'ready', data: { id: 'plugin-session-0001', heartbeatMs: 50 } })

    const events = '/api/channel/sessions/alice-only-session/events'
    const prompt = { type: 'permission_request', requestId: 'abcde', toolName: 'Bash', description: '', inputPreview: '' }
    expect((await request(ctx.app, 'POST', events, prompt, alice.plugin)).status).toBe(200)
    const target = { kind: 'review', target: { repo: 'acme/invoice-service', branch: 'b' } }
    const sent = await request(ctx.app, 'POST', '/api/channel/sessions/alice-only-session/tasks', target, alice.browser)
    const { task } = (await sent.json()) as { task: { id: string } }

    const listed = (await (await request(ctx.app, 'GET', '/api/channel/sessions', undefined, bob.browser)).json()) as ChannelState
    expect(listed).toMatchObject({ sessions: [{ id: 'plugin-session-0001', label: 'bob laptop', tokenName: 'bob channel' }], tasks: [], permissions: [] })
    expect(listed.sessions).toHaveLength(1)
    const bobEvents = sseReader(await request(ctx.app, 'GET', '/api/channel/events', undefined, bob.browser))
    expect(await bobEvents.next()).toMatchObject({ event: 'state', data: { sessions: [{ label: 'bob laptop' }], tasks: [], permissions: [] } })

    expect((await request(ctx.app, 'POST', '/api/channel/sessions/alice-only-session/tasks', target, bob.browser)).status).toBe(404)
    expect((await request(ctx.app, 'POST', '/api/channel/sessions/alice-only-session/permissions/abcde', { behavior: 'allow' }, bob.browser)).status).toBe(404)
    expect((await request(ctx.app, 'POST', '/api/channel/sessions/plugin-session-0001/permissions/abcde', { behavior: 'allow' }, bob.browser)).status).toBe(404)
    expect((await request(ctx.app, 'POST', events, { type: 'status', taskId: task.id, state: 'done' }, bob.plugin)).status).toBe(404)
    expect((await request(ctx.app, 'POST', events, { type: 'update', label: 'taken' }, bob.plugin)).status).toBe(404)
    expect((await request(ctx.app, 'DELETE', '/api/channel/sessions/alice-only-session', undefined, bob.plugin)).status).toBe(404)

    expect((await request(ctx.app, 'POST', '/api/channel/sessions/plugin-session-0001/tasks', target, bob.browser)).status).toBe(200)
    let event = await bobStream.next()
    while (event.event === 'ping') event = await bobStream.next()
    expect(event.event).toBe('task')

    const aliceState = ctx.channel.state(alice.userId)
    expect(aliceState.sessions.map((s) => [s.id, s.label, s.connected]).sort()).toEqual([
      ['alice-only-session', 'invoice-service on laptop', true],
      ['plugin-session-0001', 'invoice-service on laptop', true],
    ])
    expect(aliceState.tasks).toMatchObject([{ id: task.id, state: 'sent' }])
    expect(aliceState.permissions).toMatchObject([{ requestId: 'abcde', state: 'pending' }])
    expect(ctx.channel.state(bob.userId).tasks).toHaveLength(1)

    await Promise.all([aliceShared.close(), alicePrivate.close(), bobStream.close(), bobEvents.close()])
  })

  it('refuses a plugin past the per-user session limit', async () => {
    ctx = makeApp({ channel: createChannelRegistry({ heartbeatMs: 50, maxSessions: 1 }) })
    const alice = await signIn('alice')
    const bob = await signIn('bob')
    const first = sseReader(await alice.connect())
    await first.next()
    const second = await alice.connect({ id: 'plugin-session-0002' })
    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({ error: 'session_limit' })
    const other = sseReader(await bob.connect({ id: 'plugin-session-0002' }))
    expect((await other.next()).event).toBe('ready')
    await Promise.all([first.close(), other.close()])
  })
})
