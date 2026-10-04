import { describe, expect, it, vi } from 'vitest'
import type { ChannelTaskState, ChannelTaskView } from '../../shared/channel'
import type { ChannelSnapshot, ChannelStatus } from '../../src/channel/client'
import { INBOX_ID, type InboxItem, type InboxSnapshot } from '../../src/db/schema'
import {
  deliver,
  isAppPath,
  isQuiet,
  RequestWatch,
  requestNotice,
  TaskWatch,
  taskNotice,
  type Notice,
  type Notifier,
  type View,
} from '../../src/pwa/notifications'

const task = (id: string, state: ChannelTaskState, extra: Partial<ChannelTaskView> = {}): ChannelTaskView => ({
  id,
  channelId: 'c1',
  kind: 'review',
  repo: 'acme/web',
  branch: 'feature',
  pr: null,
  sessionId: 's1',
  state,
  message: null,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
})

const snapshot = (status: ChannelStatus, tasks: ChannelTaskView[]): ChannelSnapshot => ({
  status,
  state: { sessions: [], tasks, permissions: [] },
})

const item = (number: number, section: InboxItem['section'] = 'requested'): InboxItem => ({
  repo: 'acme/web',
  number,
  title: `PR ${number}`,
  author: 'sam',
  url: `https://github.com/acme/web/pull/${number}`,
  updatedAt: '2026-10-01T00:00:00Z',
  section,
})

const inbox = (items: InboxItem[]): InboxSnapshot => ({ id: INBOX_ID, fetchedAt: 1, items })

describe('task notifications', () => {
  it('notifies once per task that reaches done or failed, not for what had finished before', () => {
    const watch = new TaskWatch()
    expect(watch.next(snapshot('connecting', []))).toEqual([])
    expect(watch.next(snapshot('live', [task('old', 'done'), task('t1', 'working')]))).toEqual([])
    expect(watch.next(snapshot('live', [task('old', 'done'), task('t1', 'working')]))).toEqual([])

    const done = watch.next(snapshot('live', [task('old', 'done'), task('t1', 'done', { message: 'Added 3 notes' })]))
    expect(done.map((n) => [n.tag, n.title, n.body, n.path])).toEqual([
      ['task:t1:done', 'Claude finished the review', 'acme/web · feature: Added 3 notes', '/sessions/s1'],
    ])
    expect(watch.next(snapshot('live', [task('old', 'done'), task('t1', 'done')]))).toEqual([])
  })

  it('keeps what it saw across a reconnect, and starts over after signing out', () => {
    const watch = new TaskWatch()
    watch.next(snapshot('live', []))
    expect(watch.next(snapshot('live', [task('t1', 'failed')]))).toHaveLength(1)
    expect(watch.next(snapshot('retrying', [task('t1', 'failed')]))).toEqual([])
    expect(watch.next(snapshot('live', [task('t1', 'failed')]))).toEqual([])

    watch.next(snapshot('signedOut', []))
    expect(watch.next(snapshot('live', [task('t1', 'failed'), task('t2', 'done')]))).toEqual([])
  })

  it('names the target and links the session, or the pull request without one', () => {
    expect(taskNotice(task('t', 'failed', { kind: 'fix' })).title).toBe("Claude's fix failed")
    const pr = taskNotice(task('t', 'done', { kind: 'custom', sessionId: null, pr: 12, branch: null }))
    expect([pr.title, pr.body, pr.path, pr.quietOn]).toEqual(['Claude finished the task', 'acme/web#12', '/pr/acme/web/12', ['/pr/acme/web/12']])
    expect(taskNotice(task('t', 'done', { sessionId: null })).quietOn).toEqual([])
  })
})

describe('review request notifications', () => {
  it('does not notify on the first load, then once per new request', () => {
    const watch = new RequestWatch()
    expect(watch.next(undefined)).toEqual([])
    expect(watch.next(inbox([item(1), item(2, 'mine')]))).toEqual([])
    expect(watch.next(inbox([item(1), item(2, 'mine')]))).toEqual([])

    const fresh = watch.next(inbox([item(3), item(1), item(4, 'reviewed')]))
    expect(fresh.map((n) => [n.tag, n.title, n.body, n.path])).toEqual([
      ['review-request:https://github.com/acme/web/pull/3', 'Review requested: acme/web#3', 'PR 3 (@sam)', '/pr/acme/web/3'],
    ])
    expect(watch.next(inbox([item(3), item(1)]))).toEqual([])
    expect(watch.next(inbox([item(1)]))).toEqual([])
    expect(watch.next(inbox([item(3), item(1)]))).toEqual([])
  })

  it('treats the first inbox after an emptied database as a first load', () => {
    const watch = new RequestWatch()
    watch.next(inbox([item(1)]))
    watch.next(undefined)
    expect(watch.next(inbox([item(1), item(2)]))).toEqual([])
  })

  it('stays quiet on the inbox and on the pull request', () => {
    expect(requestNotice(item(5)).quietOn).toEqual(['/pr/acme/web/5', '/inbox'])
  })
})

describe('delivery', () => {
  const notice: Notice = { tag: 't', title: 'T', body: 'B', path: '/sessions/s1', quietOn: ['/sessions/s1'] }
  const view = (changes: Partial<View> = {}): View => ({ visible: true, focused: true, path: '/sessions/s1', ...changes })

  it('is quiet only while the page is visible, focused and on that session', () => {
    expect(isQuiet(notice, view())).toBe(true)
    expect(isQuiet(notice, view({ visible: false }))).toBe(false)
    expect(isQuiet(notice, view({ focused: false }))).toBe(false)
    expect(isQuiet(notice, view({ path: '/sessions/s2' }))).toBe(false)
  })

  it('shows notices only with permission, and skips the quiet ones', () => {
    const show = vi.fn()
    const other: Notice = { ...notice, tag: 'other', quietOn: ['/inbox'] }
    const notifier = (permission: Notifier['permission'] extends () => infer P ? P : never): Notifier => ({
      permission: () => permission,
      view: () => view(),
      show,
    })
    expect(deliver([notice, other], notifier('default'))).toEqual([])
    expect(deliver([notice, other], notifier('unsupported'))).toEqual([])
    expect(show).not.toHaveBeenCalled()
    expect(deliver([notice, other], notifier('granted'))).toEqual([other])
    expect(show).toHaveBeenCalledExactlyOnceWith(other)
  })

  it('accepts only paths inside the app from a notification click', () => {
    expect(isAppPath('/sessions/s1')).toBe(true)
    expect(isAppPath('//evil.example/x')).toBe(false)
    expect(isAppPath('https://evil.example/')).toBe(false)
    expect(isAppPath(undefined)).toBe(false)
  })
})
