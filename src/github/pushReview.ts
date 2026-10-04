import type { RubberduckDb } from '../db/db'
import type { Note } from '../db/schema'
import type { GitHubClient } from './client'
import { isGitHubError } from './errors'
import { pendingReview, placeNotes, commentIdsByNote, type PlacedNote, type Placement } from './push'
import type { PullRequest, RepoRef, Review } from './types'

export interface PushPreview {
  pr: PullRequest
  placement: Placement
  localHead: string
}

export type PushLookup = { kind: 'no-pr' } | { kind: 'ready'; preview: PushPreview }

export const pushableNotes = (notes: readonly Note[]) => notes.filter((note) => note.status === 'open')

export async function preparePush(
  gh: GitHubClient,
  ref: RepoRef,
  branch: string,
  localHead: string,
  notes: readonly Note[],
  renames: ReadonlyMap<string, string> = new Map(),
): Promise<PushLookup> {
  const pr = await gh.openPullForBranch(ref, branch)
  if (!pr) return { kind: 'no-pr' }
  const files = await gh.pullFiles(ref, pr.number)
  return { kind: 'ready', preview: { pr, localHead, placement: placeNotes(pushableNotes(notes), files, renames) } }
}

export interface PushSelection {
  placed: PlacedNote[]
  bodyNotes: Note[]
}

export interface PushResult {
  review: Review
  linked: number
}

export async function pushPendingReview(
  db: RubberduckDb,
  gh: GitHubClient,
  ref: RepoRef,
  pr: PullRequest,
  selection: PushSelection,
): Promise<PushResult> {
  const review = await gh.createPendingReview(ref, pr.number, pendingReview(pr.headSha, selection.placed, selection.bodyNotes))
  let commentIds = new Map<string, number>()
  if (selection.placed.length > 0) {
    try {
      commentIds = commentIdsByNote(selection.placed, await gh.reviewComments(ref, pr.number, review.id))
    } catch (error) {
      console.warn('Could not read back the review comments', error)
    }
  }
  const updates = [...selection.placed.map((entry) => entry.note), ...selection.bodyNotes].flatMap((note) =>
    note.id === undefined
      ? []
      : [{ key: note.id, changes: { github: { reviewId: review.id, commentId: commentIds.get(note.id) } } }],
  )
  await db.notes.bulkUpdate(updates)
  return { review, linked: commentIds.size }
}

export function pushErrorHint(error: unknown): string | null {
  if (isGitHubError(error, 'invalid') && /pending review/i.test(error.message)) {
    return 'You already have a pending review on this pull request. Submit or delete it on GitHub, then push again.'
  }
  return null
}
