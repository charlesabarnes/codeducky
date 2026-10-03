import type { PullDetail, PullReview } from './types'

export type ReviewerState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'REQUESTED'

export interface Reviewer {
  login: string
  state: ReviewerState
  team: boolean
}

const DECISIVE = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'])

/**
 * Each reviewer's standing, the way GitHub's sidebar shows it: a pending request wins (it was
 * re-requested), then the latest approve / request changes / dismissed, then "commented".
 */
export function reviewerStates(pull: Pick<PullDetail, 'author' | 'requestedReviewers' | 'requestedTeams'>, reviews: readonly PullReview[]): Reviewer[] {
  const latest = new Map<string, ReviewerState>()
  for (const review of reviews) {
    if (review.author === pull.author || review.state === 'PENDING') continue
    const current = latest.get(review.author)
    if (DECISIVE.has(review.state)) latest.set(review.author, review.state as ReviewerState)
    else if (review.state === 'COMMENTED' && !current) latest.set(review.author, 'COMMENTED')
  }
  for (const login of pull.requestedReviewers) latest.set(login, 'REQUESTED')
  return [
    ...[...latest].map(([login, state]) => ({ login, state, team: false })),
    ...pull.requestedTeams.map((slug) => ({ login: slug, state: 'REQUESTED' as const, team: true })),
  ]
}
