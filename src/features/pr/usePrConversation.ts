import { useEffect, useState } from 'react'
import type { GitHubClient } from '../../github/client'
import { errorMessage } from '../../github/errors'
import type { IssueComment, PullReview, RepoRef } from '../../github/types'

export interface Conversation {
  reviews: PullReview[]
  comments: IssueComment[]
}

export type ConversationState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; conversation: Conversation }

/** Submitted reviews and the PR's conversation comments. */
export function usePrConversation(gh: GitHubClient, ref: RepoRef, number: number, refreshKey: string): ConversationState {
  const [state, setState] = useState<ConversationState>({ status: 'loading' })
  const { owner, name } = ref
  useEffect(() => {
    let cancelled = false
    Promise.all([gh.pullReviews({ owner, name }, number), gh.issueComments({ owner, name }, number)])
      .then(([reviews, comments]) => !cancelled && setState({ status: 'ready', conversation: { reviews, comments } }))
      .catch((error: unknown) => !cancelled && setState({ status: 'error', message: errorMessage(error) }))
    return () => {
      cancelled = true
    }
  }, [gh, owner, name, number, refreshKey])
  return state
}
