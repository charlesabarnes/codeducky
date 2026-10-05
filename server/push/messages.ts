import type { ChannelTaskView } from '../../shared/channel'
import { prUrl, sessionUrl } from '../../shared/links'
import type { InboxRecord } from '../mcp/records'
import type { PushType } from './store'

/**
 * What a push carries: a title, a short body and the URL a click opens. Never note contents or Claude's
 * own messages. The tag matches the notification the open app shows for the same event, so the two
 * replace each other instead of stacking.
 */
export interface PushMessage {
  type: PushType
  title: string
  body: string
  url: string
  tag: string
}

type InboxItem = InboxRecord['items'][number]

const MAX_TITLE = 120
const MAX_BODY = 200

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

const TASK_NAMES: Record<ChannelTaskView['kind'], string> = { review: 'review', fix: 'fix', custom: 'task' }

function pullUrl(origin: string, repo: string, number: number): string | null {
  const [owner, name, ...rest] = repo.split('/')
  if (!owner || !name || rest.length) return null
  return prUrl(origin, { owner, name, number })
}

const home = (origin: string, path = '/') => `${origin.replace(/\/+$/, '')}${path}`

/** `origin` is CODEDUCKY_PUBLIC_URL, or '' for links relative to the app. */
export function taskMessage(task: ChannelTaskView, origin: string): PushMessage {
  const name = TASK_NAMES[task.kind]
  const target = task.pr !== null ? `${task.repo}#${task.pr}` : task.branch ? `${task.repo} · ${task.branch}` : task.repo
  const url = task.sessionId
    ? sessionUrl(origin, task.sessionId)
    : ((task.pr !== null ? pullUrl(origin, task.repo, task.pr) : null) ?? home(origin))
  return {
    type: 'tasks',
    title: task.state === 'done' ? `Claude finished the ${name}` : `Claude's ${name} failed`,
    body: clip(target, MAX_BODY),
    url,
    tag: `task:${task.id}:${task.state}`,
  }
}

/** One new request links to its pull request; several collapse into one notification for the inbox. */
export function requestsMessage(items: InboxItem[], origin: string): PushMessage {
  if (items.length === 1) {
    const [item] = items as [InboxItem]
    return {
      type: 'requests',
      title: clip(`Review requested: ${item.repo}#${item.number}`, MAX_TITLE),
      body: clip(`${item.title} (@${item.author})`, MAX_BODY),
      url: pullUrl(origin, item.repo, item.number) ?? home(origin, '/inbox'),
      tag: `review-request:${item.url}`,
    }
  }
  return {
    type: 'requests',
    title: `${items.length} new review requests`,
    body: clip(items.map((item) => `${item.repo}#${item.number}`).join(', '), MAX_BODY),
    url: home(origin, '/inbox'),
    tag: 'review-requests',
  }
}
