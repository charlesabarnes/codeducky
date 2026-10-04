import type { ChannelSessionView, ChannelTaskState, ChannelTaskView } from '../../../shared/channel'
import { timeAgo } from '../pr/time'

const STATE_LABELS: Record<ChannelTaskState, string> = {
  queued: 'waiting for the session',
  sent: 'sent',
  delivered: 'delivered',
  acknowledged: 'acknowledged',
  working: 'working',
  done: 'done',
  failed: 'failed',
}

const KIND_LABELS = { review: 'Review', fix: 'Fix notes', custom: 'Message' } as const

export function TaskList({ tasks, sessions }: { tasks: ChannelTaskView[]; sessions: ChannelSessionView[] }) {
  return (
    <ul className="claude-tasks">
      {tasks.map((task) => (
        <li key={task.id}>
          <div className="row">
            <strong>{KIND_LABELS[task.kind]}</strong>
            <span className={`claude-chip state-${task.state}`}>{STATE_LABELS[task.state]}</span>
            <span className="spacer" />
            <span className="muted" title={new Date(task.updatedAt).toLocaleString()}>
              {sessions.find((s) => s.id === task.channelId)?.label ?? 'gone'} · {timeAgo(new Date(task.updatedAt).toISOString())}
            </span>
          </div>
          {task.message && <p className="claude-task-message">{task.message}</p>}
        </li>
      ))}
    </ul>
  )
}
