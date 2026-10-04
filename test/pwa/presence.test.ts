import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChannelTaskView } from '../../shared/channel'
import type { ChannelSnapshot } from '../../src/channel/client'
import { CodeDuckyDb } from '../../src/db/db'
import { INBOX_ID, type InboxItem } from '../../src/db/schema'
import type { Notice, Notifier } from '../../src/pwa/notifications'
import { INBOX_POLL_MS, startPresence } from '../../src/pwa/presence'
import { DEFAULT_PREFS, PresencePrefsStore, prefsOf, type PresencePrefs } from '../../src/pwa/presencePrefs'

const dbs: CodeDuckyDb[] = []
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.delete()
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

function store<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    }),
    getSnapshot: () => value,
    set(next: T) {
      value = next
      listeners.forEach((listener) => listener())
    },
    get listening() {
      return listeners.size
    },
  }
}

function prefsStore(prefs: Partial<PresencePrefs>) {
  return new PresencePrefsStore({ read: () => ({ ...DEFAULT_PREFS, badge: 'off', ...prefs }), write: () => undefined })
}

const doneTask = (id: string): ChannelTaskView => ({
  id,
  channelId: 'c',
  kind: 'fix',
  repo: 'acme/web',
  branch: 'b',
  pr: null,
  sessionId: 's1',
  state: 'done',
  message: null,
  createdAt: 1,
  updatedAt: 1,
})

const request = (number: number): InboxItem => ({
  repo: 'acme/web',
  number,
  title: 't',
  author: 'a',
  url: `u${number}`,
  updatedAt: '',
  section: 'requested',
})

function setup(prefs: Partial<PresencePrefs>, permission: NotificationPermission = 'granted') {
  const db = new CodeDuckyDb(`presence-${Math.random()}`)
  dbs.push(db)
  const shown: Notice[] = []
  const notifier: Notifier = {
    permission: () => permission,
    view: () => ({ visible: false, focused: false, path: '/' }),
    show: (notice) => shown.push(notice),
  }
  const channel = store<ChannelSnapshot>({ status: 'connecting', state: { sessions: [], tasks: [], permissions: [] } })
  const timers: { run: () => void; ms: number; stopped: boolean }[] = []
  const setInterval = (run: () => void, ms: number) => {
    const timer = { run, ms, stopped: false }
    timers.push(timer)
    return () => void (timer.stopped = true)
  }
  const pollInbox = vi.fn(async () => undefined)
  const p = prefsStore(prefs)
  const stop = startPresence({ db, prefs: p, channel, notifier, pollInbox, setInterval })
  return { db, prefs: p, channel, shown, timers, pollInbox, stop }
}

const live = (tasks: ChannelTaskView[]): ChannelSnapshot => ({ status: 'live', state: { sessions: [], tasks, permissions: [] } })

describe('presence', () => {
  it('watches nothing until notifications are turned on', () => {
    const { channel, timers } = setup({ notifications: false })
    expect(channel.listening).toBe(0)
    expect(timers).toEqual([])
  })

  it('needs the browser permission as well as the opt-in', () => {
    const { channel } = setup({ notifications: true }, 'default')
    expect(channel.listening).toBe(0)
  })

  it('notifies finished tasks while on, and lets go of the channel when turned off', () => {
    const { channel, shown, prefs } = setup({ notifications: true })
    expect(channel.listening).toBe(1)
    channel.set(live([doneTask('old')]))
    channel.set(live([doneTask('old'), doneTask('new')]))
    expect(shown.map((n) => n.tag)).toEqual(['task:new:done'])

    prefs.update({ notifyTasks: false })
    expect(channel.listening).toBe(0)
  })

  it('notifies new review requests from the stored inbox', async () => {
    const { db, shown } = setup({ notifications: true, notifyTasks: false })
    await db.inbox.put({ id: INBOX_ID, fetchedAt: 1, items: [request(1)] })
    await settle()
    await db.inbox.put({ id: INBOX_ID, fetchedAt: 2, items: [request(2), request(1)] })
    await settle()
    expect(shown.map((n) => n.path)).toEqual(['/pr/acme/web/2'])
  })

  it('polls the inbox while review requests notify or count on the badge', () => {
    const { timers, prefs, pollInbox } = setup({ notifications: true })
    expect(timers.map((t) => [t.ms, t.stopped])).toEqual([[INBOX_POLL_MS, false]])
    timers[0]!.run()
    expect(pollInbox).toHaveBeenCalledOnce()

    prefs.update({ notifyRequests: false })
    expect(timers[0]!.stopped).toBe(true)
    prefs.update({ badge: 'requests' })
    expect(timers.filter((t) => !t.stopped)).toHaveLength(1)
  })

  it('stops everything', () => {
    const { channel, timers, stop } = setup({ notifications: true })
    stop()
    expect(channel.listening).toBe(0)
    expect(timers.every((t) => t.stopped)).toBe(true)
  })
})

describe('presence prefs', () => {
  it('falls back to the defaults for missing or unknown values', () => {
    expect(prefsOf(null)).toEqual(DEFAULT_PREFS)
    expect(prefsOf({ badge: 'requests', notifications: true, notifyTasks: 'yes' })).toEqual({
      ...DEFAULT_PREFS,
      badge: 'requests',
      notifications: true,
    })
    expect(prefsOf({ badge: 'everything' }).badge).toBe(DEFAULT_PREFS.badge)
  })

  it('saves changes and tells subscribers', () => {
    const write = vi.fn()
    const prefs = new PresencePrefsStore({ read: () => null, write })
    const listener = vi.fn()
    prefs.subscribe(listener)
    prefs.update({ badge: 'off' })
    expect(prefs.getSnapshot().badge).toBe('off')
    expect(write).toHaveBeenCalledWith({ ...DEFAULT_PREFS, badge: 'off' })
    expect(listener).toHaveBeenCalledOnce()
  })
})
