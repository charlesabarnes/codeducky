import type { SkelbertDb } from '../db/db'
import type { Note, SubmittedReviewState } from '../db/schema'
import { compareNotes } from '../review/summary'
import type { GitHubClient } from './client'
import { placeNotes, reviewBody, type Placement } from './push'
import { pushableNotes, type PushLookup, type PushResult, type PushSelection } from './pushReview'
import { addThreadToReview, type PendingReview } from './threads'
import type { PullDetail, PullFile, RepoRef, Review, ReviewEvent } from './types'

export const EVENT_STATE: Record<ReviewEvent, SubmittedReviewState> = {
  APPROVE: 'APPROVED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
  COMMENT: 'COMMENTED',
}

export const EVENT_LABEL: Record<ReviewEvent, string> = {
  COMMENT: 'Comment',
  APPROVE: 'Approve',
  REQUEST_CHANGES: 'Request changes',
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
const SEVERITY_ORDER = ['blocker', 'issue', 'suggestion', 'nit'] as const

const firstLine = (note: Note) => {
  const text = (note.title ?? note.body.split('\n').find((line) => line.trim()) ?? '').trim()
  return text.length > 100 ? `${text.slice(0, 99)}…` : text
}

/** The default review body: what your notes add up to, worst first. */
export function reviewSummary(notes: readonly Note[]): string {
  const open = notes.filter((note) => note.status === 'open')
  if (open.length === 0) return ''
  const counts = SEVERITY_ORDER.map((severity) => [severity, open.filter((note) => note.severity === severity).length] as const).filter(
    ([, count]) => count > 0,
  )
  const ranked = [...open].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || compareNotes(a, b),
  )
  return [
    `${plural(open.length, 'note')}: ${counts.map(([severity, count]) => `${count} ${severity}`).join(', ')}.`,
    '',
    ...ranked.map((note) => `- **${note.severity}** \`${note.path}:${note.anchor.line}\` ${firstLine(note)}`),
  ].join('\n')
}

/** Notes still to send: open, and not already in a review on GitHub. */
export const unpushedNotes = (notes: readonly Note[]) => pushableNotes(notes).filter((note) => note.github?.reviewId === undefined)

const toPullRequest = (pull: PullDetail) => ({
  number: pull.number,
  title: pull.title,
  htmlUrl: pull.htmlUrl,
  draft: pull.draft,
  headSha: pull.headSha,
  headRef: pull.headRef,
  baseRef: pull.baseRef,
})

/** The push preview for a pull request session: the session diff is the PR diff, so no branch lookup is needed. */
export function preparePrPush(pull: PullDetail, files: readonly PullFile[], notes: readonly Note[]): PushLookup {
  return {
    kind: 'ready',
    preview: { pr: toPullRequest(pull), localHead: pull.headSha, placement: placeNotes(pushableNotes(notes), files) },
  }
}

async function linkNotes(db: SkelbertDb, notes: readonly Note[], reviewId: number, commentIds: ReadonlyMap<string, number> = new Map()) {
  const updates = notes.flatMap((note) =>
    note.id === undefined ? [] : [{ key: note.id, changes: { github: { reviewId, commentId: commentIds.get(note.id) } } }],
  )
  if (updates.length) await db.notes.bulkUpdate(updates)
}

/**
 * Adds notes to your existing pending review: each placed note becomes a thread on it, and notes
 * that do not map onto the diff are appended to its body.
 */
export async function pushToPendingReview(
  db: SkelbertDb,
  gh: GitHubClient,
  ref: RepoRef,
  number: number,
  pending: PendingReview,
  selection: PushSelection,
): Promise<PushResult> {
  if (pending.databaseId === null) throw new Error('GitHub did not report the id of your pending review.')
  const commentIds = new Map<string, number>()
  for (const { note, comment } of selection.placed) {
    const id = await addThreadToReview(gh, pending.id, comment)
    if (id !== null && note.id !== undefined) commentIds.set(note.id, id)
  }
  if (selection.bodyNotes.length > 0) {
    const extra = reviewBody(selection.bodyNotes)
    await gh.updateReviewBody(ref, number, pending.databaseId, pending.body.trim() ? `${pending.body.trim()}\n\n${extra}` : extra)
  }
  await linkNotes(db, [...selection.placed.map((entry) => entry.note), ...selection.bodyNotes], pending.databaseId, commentIds)
  return { review: { id: pending.databaseId, state: 'PENDING', htmlUrl: pending.url }, linked: commentIds.size }
}

export interface SubmitInput {
  event: ReviewEvent
  body: string
  /** Unpushed notes to include: placed ones as inline comments, the rest in the body. */
  placement: Placement | null
}

export interface SubmitResult {
  review: Review
  state: SubmittedReviewState
  comments: number
}

/** The body as submitted: yours, plus notes that do not map onto the diff. */
export function submitBody(input: SubmitInput): string {
  const extra = input.placement && input.placement.unplaced.length > 0 ? reviewBody(input.placement.unplaced.map((entry) => entry.note)) : ''
  return [input.body.trim(), extra].filter(Boolean).join('\n\n')
}

/**
 * Submits your review. With a pending review on GitHub, unpushed notes are added to it and it is
 * submitted; without one, a review is created and submitted in a single call.
 */
export async function submitPrReview(
  db: SkelbertDb,
  gh: GitHubClient,
  ref: RepoRef,
  pull: Pick<PullDetail, 'number' | 'headSha'>,
  pending: PendingReview | null,
  input: SubmitInput,
): Promise<SubmitResult> {
  const placed = input.placement?.placed ?? []
  const included = [...placed.map((entry) => entry.note), ...(input.placement?.unplaced.map((entry) => entry.note) ?? [])]
  const body = submitBody(input)
  let review: Review
  if (pending) {
    if (pending.databaseId === null) throw new Error('GitHub did not report the id of your pending review.')
    for (const { comment } of placed) await addThreadToReview(gh, pending.id, comment)
    review = await gh.submitReview(ref, pull.number, pending.databaseId, input.event, body)
  } else {
    review = await gh.createReview(ref, pull.number, {
      commitId: pull.headSha,
      body,
      event: input.event,
      comments: placed.map((entry) => entry.comment),
    })
  }
  await linkNotes(db, included, review.id)
  return { review, state: EVENT_STATE[input.event], comments: placed.length }
}

/** GitHub refuses a review with no body and no comments unless it approves. */
export function needsBody(input: SubmitInput, pendingComments: number): boolean {
  const comments = (input.placement?.placed.length ?? 0) + pendingComments
  return input.event !== 'APPROVE' && comments === 0 && !submitBody(input)
}

export async function archiveWithReview(db: SkelbertDb, sessionId: string, result: SubmitResult, now = Date.now()): Promise<void> {
  await db.sessions.update(sessionId, { status: 'archived', review: { state: result.state, at: now, url: result.review.htmlUrl } })
}
