import type { PullDetail } from '../../github/types'
import { Markdown } from '../notes/Markdown'
import type { ConversationState } from './usePrConversation'
import { timeAgo } from './time'

const REVIEW_VERB: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'requested changes',
  COMMENTED: 'reviewed',
  DISMISSED: 'reviewed (dismissed)',
}

interface Entry {
  key: string
  author: string
  at: string
  verb: string
  body: string
  url: string
}

/** The PR's conversation: comments that are not on a line, and review summaries, oldest first. */
export function ConversationPanel({ pull, state }: { pull: PullDetail; state: ConversationState }) {
  if (state.status === 'loading') return <p className="muted panel-pad">Loading the conversation…</p>
  if (state.status === 'error') return <p className="error panel-pad">{state.message}</p>
  const { reviews, comments } = state.conversation
  const entries: Entry[] = [
    ...comments.map((comment) => ({ key: `c${comment.id}`, author: comment.author, at: comment.createdAt, verb: 'commented', body: comment.body, url: comment.htmlUrl })),
    ...reviews
      .filter((review) => review.state !== 'PENDING' && (review.body.trim() || review.state !== 'COMMENTED'))
      .map((review) => ({
        key: `r${review.id}`,
        author: review.author,
        at: review.submittedAt ?? '',
        verb: REVIEW_VERB[review.state] ?? review.state.toLowerCase(),
        body: review.body,
        url: review.htmlUrl,
      })),
  ].sort((a, b) => a.at.localeCompare(b.at))

  return (
    <div className="conversation">
      <article className="conversation-entry">
        <div className="thread-comment-meta">
          <strong>{pull.author}</strong> <span className="muted">opened {timeAgo(pull.createdAt)}</span>
        </div>
        {pull.body.trim() ? <Markdown text={pull.body} /> : <p className="muted">No description.</p>}
      </article>
      {entries.length === 0 && <p className="muted panel-pad">No conversation comments yet.</p>}
      {entries.map((entry) => (
        <article key={entry.key} className="conversation-entry">
          <div className="thread-comment-meta">
            <strong>{entry.author}</strong> <span className="muted">{entry.verb} {timeAgo(entry.at)}</span>
            <span className="spacer" />
            <a href={entry.url} target="_blank" rel="noreferrer" className="muted">
              GitHub
            </a>
          </div>
          {entry.body.trim() && <Markdown text={entry.body} />}
        </article>
      ))}
    </div>
  )
}
