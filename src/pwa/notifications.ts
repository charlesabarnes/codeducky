import { isFinished, type ChannelTaskView } from '../../shared/channel'
import type { ChannelSnapshot } from '../channel/client'
import type { InboxItem, InboxSnapshot } from '../db/schema'

export interface Notice {
  /** Notifications with the same tag replace each other, so two windows showing one event make one notification. */
  tag: string
  title: string
  body: string
  /** Where a click takes the app. */
  path: string
  /** Pages that already show the event: no notification while one of them is visible and focused. */
  quietOn: string[]
}

export const sessionPath = (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}`
const prPath = (repo: string, number: number) => `/pr/${repo}/${number}`

const TASK_NAMES: Record<ChannelTaskView['kind'], string> = { review: 'review', fix: 'fix', custom: 'task' }

function taskTarget(task: ChannelTaskView): string {
  if (task.pr !== null) return `${task.repo}#${task.pr}`
  return task.branch ? `${task.repo} · ${task.branch}` : task.repo
}

export function taskNotice(task: ChannelTaskView): Notice {
  const name = TASK_NAMES[task.kind]
  const path = task.sessionId ? sessionPath(task.sessionId) : task.pr !== null ? prPath(task.repo, task.pr) : '/'
  return {
    tag: `task:${task.id}:${task.state}`,
    title: task.state === 'done' ? `Claude finished the ${name}` : `Claude's ${name} failed`,
    body: task.message ? `${taskTarget(task)}: ${task.message}` : taskTarget(task),
    path,
    quietOn: path === '/' ? [] : [path],
  }
}

export function requestNotice(item: InboxItem): Notice {
  const path = prPath(item.repo, item.number)
  return {
    tag: `review-request:${item.url}`,
    title: `Review requested: ${item.repo}#${item.number}`,
    body: `${item.title} (@${item.author})`,
    path,
    quietOn: [path, '/inbox'],
  }
}

/**
 * Turns channel snapshots into notices for tasks that reached done or failed. The first live snapshot
 * only records what had already finished; signing out starts over.
 */
export class TaskWatch {
  private seen: Set<string> | null = null

  next({ status, state }: ChannelSnapshot): Notice[] {
    if (status === 'signedOut') this.seen = null
    if (status !== 'live') return []
    const finished = state.tasks.filter((task) => isFinished(task.state))
    const key = (task: ChannelTaskView) => `${task.id}:${task.state}`
    if (!this.seen) {
      this.seen = new Set(finished.map(key))
      return []
    }
    const fresh = finished.filter((task) => !this.seen!.has(key(task)))
    fresh.forEach((task) => this.seen!.add(key(task)))
    return fresh.map(taskNotice)
  }
}

/**
 * Turns inbox snapshots (fetched here or synced from another device) into notices for review requests
 * not seen before. The first snapshot only records what is there; an empty inbox (a new account) starts over.
 */
export class RequestWatch {
  private seen: Set<string> | null = null

  next(snapshot: InboxSnapshot | undefined): Notice[] {
    if (!snapshot) {
      this.seen = null
      return []
    }
    const requested = snapshot.items.filter((item) => item.section === 'requested')
    if (!this.seen) {
      this.seen = new Set(requested.map((item) => item.url))
      return []
    }
    const fresh = requested.filter((item) => !this.seen!.has(item.url))
    fresh.forEach((item) => this.seen!.add(item.url))
    return fresh.map(requestNotice)
  }
}

export interface View {
  visible: boolean
  focused: boolean
  /** The app's current path. */
  path: string
}

/** Someone looking at the page that already shows the event does not need a notification for it. */
export const isQuiet = (notice: Notice, view: View) => view.visible && view.focused && notice.quietOn.includes(view.path)

export interface Notifier {
  permission: () => NotificationPermission | 'unsupported'
  view: () => View
  show: (notice: Notice) => void
}

/** Shows the notices the permission and the current view allow; returns the ones shown. */
export function deliver(notices: Notice[], notifier: Notifier): Notice[] {
  if (notices.length === 0 || notifier.permission() !== 'granted') return []
  const shown = notices.filter((notice) => !isQuiet(notice, notifier.view()))
  shown.forEach((notice) => notifier.show(notice))
  return shown
}

/** The message the notification click handler in the service worker posts to an open window. */
export const NAVIGATE_MESSAGE = 'codeducky:navigate'

/** A path inside the app, never another origin. */
export const isAppPath = (path: unknown): path is string => typeof path === 'string' && path.startsWith('/') && !path.startsWith('//')

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

export function browserView(): View {
  return { visible: document.visibilityState === 'visible', focused: document.hasFocus(), path: location.pathname }
}

/**
 * Shows a notification from the page, so a click can focus this window and navigate in it. Where pages
 * cannot construct notifications (Android), the service worker shows it and its click handler does the same.
 */
export function showBrowserNotification(notice: Notice, navigate: (path: string) => void): void {
  const options: NotificationOptions = { body: notice.body, tag: notice.tag, icon: '/pwa-192x192.png', data: { path: notice.path } }
  try {
    const notification = new Notification(notice.title, options)
    notification.onclick = () => {
      window.focus()
      navigate(notice.path)
      notification.close()
    }
  } catch {
    navigator.serviceWorker?.ready
      .then((registration) => registration.showNotification(notice.title, options))
      .catch((error: unknown) => console.warn('Could not show a notification', error))
  }
}
