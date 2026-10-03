import type { PrSnapshot } from '../../github/prDiff'
import { reviewerStates, type ReviewerState } from '../../github/reviewers'
import type { PendingReview } from '../../github/threads'
import type { PullLabel } from '../../github/types'
import { Markdown } from '../notes/Markdown'
import type { ConversationState } from './usePrConversation'
import { PrLinks } from './PrLinks'
import { timeAgo } from './time'
import './pr.css'

const REVIEWER_ICON: Record<ReviewerState, string> = { APPROVED: '✓', CHANGES_REQUESTED: '✕', COMMENTED: '◦', DISMISSED: '–', REQUESTED: '●' }
const REVIEWER_LABEL: Record<ReviewerState, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'requested changes',
  COMMENTED: 'commented',
  DISMISSED: 'review dismissed',
  REQUESTED: 'review requested',
}

/** Label text in black or white, whichever reads better on the label's colour. */
function labelStyle({ color }: PullLabel) {
  if (!color || !/^[0-9a-f]{6}$/i.test(color)) return undefined
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(color.slice(i, i + 2), 16))
  const light = (r! * 299 + g! * 587 + b! * 114) / 1000 > 140
  return { background: `#${color}`, color: light ? '#1f2328' : '#ffffff', borderColor: 'transparent' }
}

interface PrHeaderProps {
  snapshot: PrSnapshot
  conversation: ConversationState
  pendingReview: PendingReview | null
}

export function PrHeader({ snapshot, conversation, pendingReview }: PrHeaderProps) {
  const { pull, ref } = snapshot
  const reviews = conversation.status === 'ready' ? conversation.conversation.reviews : []
  const reviewers = reviewerStates(pull, reviews)
  const state = pull.draft && pull.state === 'open' ? 'draft' : pull.state
  return (
    <header className="pr-header" aria-label="Pull request">
      <div className="pr-title row">
        <span className={`pr-state state-${state}`}>{state}</span>
        <h1>
          {pull.title} <span className="muted">#{pull.number}</span>
        </h1>
        <span className="spacer" />
        <PrLinks pull={{ ...ref, number: pull.number }} />
      </div>
      <div className="pr-meta row">
        <span>
          <strong>{pull.author}</strong> wants to merge into
        </span>
        <span className="mono branch-pair" title="base ← head">
          {pull.baseRef} ← {pull.headRepo && pull.headRepo !== `${ref.owner}/${ref.name}` ? `${pull.headRepo.split('/')[0]}:` : ''}
          {pull.headRef}
        </span>
        <span className="muted">· opened {timeAgo(pull.createdAt)}</span>
        {pull.labels.map((label) => (
          <span key={label.name} className="badge pr-label" style={labelStyle(label)}>
            {label.name}
          </span>
        ))}
      </div>
      {reviewers.length > 0 && (
        <ul className="pr-reviewers" aria-label="Reviewers">
          {reviewers.map((reviewer) => (
            <li key={`${reviewer.team ? 'team:' : ''}${reviewer.login}`} className={`reviewer state-${reviewer.state}`} title={REVIEWER_LABEL[reviewer.state]}>
              <span aria-hidden="true">{REVIEWER_ICON[reviewer.state]}</span> {reviewer.team ? `@${ref.owner}/${reviewer.login}` : reviewer.login}
              <span className="sr-only"> {REVIEWER_LABEL[reviewer.state]}</span>
            </li>
          ))}
        </ul>
      )}
      {pendingReview && (
        <p className="pr-pending">
          You have a pending review on GitHub with {pendingReview.comments} {pendingReview.comments === 1 ? 'comment' : 'comments'}. Only you
          can see it until you submit it; new notes are added to it.
        </p>
      )}
      <details className="pr-description">
        <summary>Description</summary>
        {pull.body.trim() ? <Markdown text={pull.body} /> : <p className="muted">No description.</p>}
      </details>
    </header>
  )
}
