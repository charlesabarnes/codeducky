import type { Note } from '../db/schema'
import type { NumberedLine } from '../review/lines'
import { matchAnchor } from '../review/match'
import { patchSideLines } from '../review/patch'
import { fenceFor, noteExcerpt } from '../review/report'
import { compareNotes } from '../review/summary'
import type { PendingReviewInput, PullFile, ReviewComment, ReviewCommentInput, ReviewSide } from './types'

export interface PlacedNote {
  note: Note
  comment: ReviewCommentInput
  exact: boolean
}

export interface UnplacedNote {
  note: Note
  reason: string
}

export interface Placement {
  placed: PlacedNote[]
  unplaced: UnplacedNote[]
}

const sideOf = (note: Note): ReviewSide => (note.anchor.side === 'old' ? 'LEFT' : 'RIGHT')

export function commentBody(note: Note): string {
  return `**${note.severity}:** ${note.body.trim() || '_No text._'}`
}

/** Maps each note onto the PR's patch for its file, using the same matcher as local re-anchoring. */
export function placeNotes(notes: readonly Note[], files: readonly PullFile[]): Placement {
  const byPath = new Map(files.map((file) => [file.path, file]))
  const sides = new Map<string, NumberedLine[]>()
  const linesFor = (file: PullFile, side: ReviewSide) => {
    const key = `${side}:${file.path}`
    let lines = sides.get(key)
    if (!lines) {
      lines = patchSideLines(file.patch ?? '', side)
      sides.set(key, lines)
    }
    return lines
  }

  const placement: Placement = { placed: [], unplaced: [] }
  for (const note of [...notes].sort(compareNotes)) {
    const file = byPath.get(note.path)
    if (!file) {
      placement.unplaced.push({ note, reason: 'File is not changed in the pull request' })
      continue
    }
    if (file.patch === null) {
      placement.unplaced.push({ note, reason: 'GitHub shows no diff for this file (binary or too large)' })
      continue
    }
    const side = sideOf(note)
    const match = matchAnchor(note.anchor, linesFor(file, side))
    if (!match) {
      placement.unplaced.push({ note, reason: 'Line is not in the pull request diff' })
      continue
    }
    placement.placed.push({
      note,
      exact: match.kind === 'exact',
      comment: { path: file.path, line: match.line, side, body: commentBody(note) },
    })
  }
  return placement
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `  ${line}` : ''))
    .join('\n')
}

function bodyItem(note: Note): string {
  const where = `line ${note.anchor.line}${note.anchor.side === 'old' ? ' (base)' : ''}`
  const excerpt = noteExcerpt(note)
  const fence = fenceFor(excerpt)
  const text = note.body.trim() || '_No text._'
  return [`- **${note.severity}** in \`${note.path}\`, ${where}:`, '', indent(text), '', indent(`${fence}\n${excerpt}\n${fence}`)].join(
    '\n',
  )
}

export function reviewBody(notes: readonly Note[]): string {
  if (notes.length === 0) return ''
  return ['Notes that do not map onto the diff:', '', [...notes].sort(compareNotes).map(bodyItem).join('\n\n')].join('\n')
}

export function pendingReview(commitId: string, placed: readonly PlacedNote[], bodyNotes: readonly Note[]): PendingReviewInput {
  return { commitId, body: reviewBody(bodyNotes), comments: placed.map((entry) => entry.comment) }
}

/** Pairs the comments GitHub created with the notes they came from (the create call does not return comment ids). */
export function commentIdsByNote(placed: readonly PlacedNote[], comments: readonly ReviewComment[]): Map<string, number> {
  const unused = [...comments]
  const ids = new Map<string, number>()
  for (const { note, comment } of placed) {
    const index = unused.findIndex(
      (c) => c.path === comment.path && c.body === comment.body && (c.line === null || c.line === comment.line),
    )
    if (index < 0 || note.id === undefined) continue
    ids.set(note.id, unused[index]!.id)
    unused.splice(index, 1)
  }
  return ids
}
