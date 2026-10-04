import { describe, expect, it, vi } from 'vitest'
import { matchSessions, type ChannelSessionView, type ChannelState } from '../../shared/channel'
import { ChannelClient } from '../../src/channel/client'

const session = (overrides: Partial<ChannelSessionView>): ChannelSessionView => ({
  id: 's',
  label: 'app on laptop',
  cwd: '/src/app',
  repo: 'acme/app',
  branch: 'main',
  hostname: 'laptop',
  pluginVersion: '0.1.0',
  tokenName: 'Claude channel',
  connected: true,
  connectedAt: 1,
  lastSeenAt: 1,
  ...overrides,
})

describe('matchSessions', () => {
  it('keeps sessions in the same repo, connected and same-branch first', () => {
    const sessions = [
      session({ id: 'other-repo', repo: 'acme/web' }),
      session({ id: 'other-branch', branch: 'main', lastSeenAt: 5 }),
      session({ id: 'same-branch', branch: 'feature/x', lastSeenAt: 2 }),
      session({ id: 'gone', branch: 'feature/x', connected: false, lastSeenAt: 9 }),
      session({ id: 'no-remote', repo: null }),
    ]
    expect(matchSessions(sessions, 'ACME/App', 'feature/x').map((s) => s.id)).toEqual(['same-branch', 'other-branch', 'gone'])
    expect(matchSessions(sessions, 'acme/app').map((s) => s.id)).toEqual(['other-branch', 'same-branch', 'gone'])
  })
})

const sse = (...states: ChannelState[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const state of states) controller.enqueue(new TextEncoder().encode(`event: state\ndata: ${JSON.stringify(state)}\n\n: ping\n\n`))
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )

describe('ChannelClient', () => {
  it('follows the event stream while subscribed, with the device token', async () => {
    const state: ChannelState = { sessions: [session({ id: 'a' })], tasks: [], permissions: [] }
    const fetchMock = vi.fn(async () => sse(state))
    const client = new ChannelClient({ token: () => 'device-token', onAuthChange: () => () => undefined, request: vi.fn(), fetch: fetchMock as unknown as typeof fetch })
    const seen: string[] = []
    const unsubscribe = client.subscribe(() => seen.push(client.getSnapshot().status))
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe('live'))
    expect(client.getSnapshot().state.sessions.map((s) => s.id)).toEqual(['a'])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/channel/events')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer device-token')
    unsubscribe()
    expect((init.signal as AbortSignal).aborted).toBe(true)
  })

  it('stays signed out without a token and connects once one appears', async () => {
    let token: string | null = null
    let authListener = () => {}
    const fetchMock = vi.fn(async () => sse({ sessions: [], tasks: [], permissions: [] }))
    const client = new ChannelClient({
      token: () => token,
      onAuthChange: (listener) => {
        authListener = listener
        return () => undefined
      },
      request: vi.fn(),
      fetch: fetchMock as unknown as typeof fetch,
    })
    const unsubscribe = client.subscribe(() => undefined)
    expect(client.getSnapshot().status).toBe('signedOut')
    expect(fetchMock).not.toHaveBeenCalled()
    token = 'device-token'
    authListener()
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe('live'))
    unsubscribe()
  })

  it('sends tasks and verdicts through the authenticated request helper', async () => {
    const request = vi.fn(async () => ({ ok: true }))
    const client = new ChannelClient({ token: () => 't', onAuthChange: () => () => undefined, request: request as never })
    await client.sendTask('chan/1', { kind: 'review', target: { repo: 'acme/app', branch: 'main' } })
    await client.decide('chan/1', 'abcde', 'deny')
    expect(request.mock.calls).toEqual([
      ['POST', '/api/channel/sessions/chan%2F1/tasks', { kind: 'review', target: { repo: 'acme/app', branch: 'main' } }],
      ['POST', '/api/channel/sessions/chan%2F1/permissions/abcde', { behavior: 'deny' }],
    ])
  })
})
