import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const SCRIPT = readFileSync(join(import.meta.dirname, '../../public/push.js'), 'utf8')
const ORIGIN = 'https://ducky.example'

interface Client {
  url: string
  focused: boolean
}

/** Loads the service worker's push handler against a fake worker scope, and fires one push at it. */
async function push(payload: unknown, windows: Client[] = []) {
  const handlers = new Map<string, (event: unknown) => void>()
  const showNotification = vi.fn(async () => undefined)
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler),
    clients: { matchAll: vi.fn(async () => windows) },
    registration: { showNotification },
  }
  runInNewContext(SCRIPT, { self, URL })
  let pending: Promise<unknown> = Promise.resolve()
  const data = payload === undefined ? null : { json: () => (typeof payload === 'string' ? JSON.parse(payload) : payload) }
  handlers.get('push')!({ data, waitUntil: (promise: Promise<unknown>) => (pending = promise) })
  await pending
  return showNotification
}

const MESSAGE = { title: 'Claude finished the fix', body: 'acme/web · main', url: `${ORIGIN}/sessions/s1`, tag: 'task:t1:done' }

describe('service worker push handler', () => {
  it('shows the message with the app path for the click handler', async () => {
    const shown = await push(MESSAGE)
    expect(shown).toHaveBeenCalledWith('Claude finished the fix', {
      body: 'acme/web · main',
      tag: 'task:t1:done',
      icon: '/pwa-192x192.png',
      data: { path: '/sessions/s1' },
    })
  })

  it('shows nothing while a window of the app has focus, which shows its own', async () => {
    expect(await push(MESSAGE, [{ url: `${ORIGIN}/inbox`, focused: true }])).not.toHaveBeenCalled()
    expect(await push(MESSAGE, [{ url: `${ORIGIN}/inbox`, focused: false }])).toHaveBeenCalledOnce()
  })

  it('opens relative links in the app and never another origin', async () => {
    const relative = await push({ ...MESSAGE, url: '/pr/acme/web/3' })
    expect(relative.mock.calls[0]).toMatchObject([MESSAGE.title, { data: { path: '/pr/acme/web/3' } }])
    const elsewhere = await push({ ...MESSAGE, url: 'https://evil.example/x' })
    expect(elsewhere.mock.calls[0]).toMatchObject([MESSAGE.title, { data: { path: '/' } }])
  })

  it('ignores an empty or malformed push', async () => {
    expect(await push(undefined)).not.toHaveBeenCalled()
    expect(await push('not json')).not.toHaveBeenCalled()
    expect(await push({ body: 'no title' })).not.toHaveBeenCalled()
  })
})
