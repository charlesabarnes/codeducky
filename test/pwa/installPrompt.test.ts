import { describe, expect, it, vi } from 'vitest'
import { InstallPrompt } from '../../src/pwa/installPrompt'

function fakeWindow() {
  const listeners = new Map<string, (event: Event) => void>()
  return {
    addEventListener: (type: string, listener: (event: Event) => void) => listeners.set(type, listener),
    fire: (type: string, event: Event = new Event(type)) => listeners.get(type)?.(event),
  }
}

function promptEvent(outcome: 'accepted' | 'dismissed') {
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: vi.fn(async () => undefined),
    userChoice: Promise.resolve({ outcome }),
  })
  return event
}

const create = (installed = false) => {
  const events = fakeWindow()
  const store = new InstallPrompt({ events: events as unknown as Window, installed: () => installed })
  return { events, store }
}

describe('install prompt', () => {
  it('has nothing to offer until the browser fires beforeinstallprompt', async () => {
    const { store } = create()
    expect(store.getSnapshot()).toEqual({ installed: false, available: false })
    expect(await store.prompt()).toBe('unavailable')
  })

  it('keeps the event for its own button instead of the browser infobar', () => {
    const { events, store } = create()
    const listener = vi.fn()
    store.subscribe(listener)
    const event = promptEvent('accepted')
    events.fire('beforeinstallprompt', event)
    expect(event.defaultPrevented).toBe(true)
    expect(store.getSnapshot()).toEqual({ installed: false, available: true })
    expect(listener).toHaveBeenCalled()
  })

  it('uses the prompt once, and marks the app installed when accepted', async () => {
    const { events, store } = create()
    const event = promptEvent('accepted')
    events.fire('beforeinstallprompt', event)
    expect(await store.prompt()).toBe('accepted')
    expect(event.prompt).toHaveBeenCalledOnce()
    expect(store.getSnapshot()).toEqual({ installed: true, available: false })
    expect(await store.prompt()).toBe('unavailable')
  })

  it('stays not installed when dismissed', async () => {
    const { events, store } = create()
    events.fire('beforeinstallprompt', promptEvent('dismissed'))
    expect(await store.prompt()).toBe('dismissed')
    expect(store.getSnapshot()).toEqual({ installed: false, available: false })
  })

  it('hides the offer once installed from the browser menu', () => {
    const { events, store } = create()
    events.fire('beforeinstallprompt', promptEvent('accepted'))
    events.fire('appinstalled')
    expect(store.getSnapshot()).toEqual({ installed: true, available: false })
  })

  it('starts as installed when running as the app', () => {
    expect(create(true).store.getSnapshot().installed).toBe(true)
  })
})
