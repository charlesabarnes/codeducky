import type { Note, NoteAnchor, NoteSide } from '../db/schema'
import { anchoredText, createAnchor, lastLine } from './anchor'
import type { NumberedLine } from './lines'
import { matchAnchor, type AnchorMatch } from './match'

/**
 * What the diff on screen is, for placing notes on it.
 * - `all`: the branch against its base. Notes are stored against this.
 * - `interdiff`: since last look; the new side is the current content, the old side what you reviewed.
 * - `commit`: one commit or a range; the new side is the file as of `sha`, the old side its parent's.
 */
export type NoteView = { kind: 'all' } | { kind: 'interdiff' } | { kind: 'commit'; sha: string }

export interface PlacedNotes {
  /** Notes to draw on this diff (copies, with line numbers moved onto it where needed). */
  placed: Note[]
  /** Notes on lines this diff does not show: the base side, or another commit. */
  elsewhere: Note[]
}

/**
 * Places a file's notes on the diff being shown. Stored anchors always point at the final content (new side) or
 * the base (old side), except notes marked with a commit, which point at that commit's lines.
 */
export function placeNotes(notes: readonly Note[], newLines: readonly NumberedLine[] | null, view: NoteView): PlacedNotes {
  const placed: Note[] = []
  const elsewhere: Note[] = []
  for (const note of notes) {
    if (note.commit) {
      if (view.kind === 'commit' && view.sha === note.commit) placed.push(note)
      else elsewhere.push(note)
      continue
    }
    if (view.kind === 'all' || note.anchorLost) {
      placed.push(note)
      continue
    }
    if (note.anchor.side === 'old') {
      elsewhere.push(note)
      continue
    }
    if (view.kind === 'interdiff') {
      placed.push(note)
      continue
    }
    const match = newLines ? matchAnchor(note.anchor, newLines) : null
    if (match) placed.push(match.line === note.anchor.line && match.endLine === lastLine(note.anchor) ? note : { ...note, anchor: moveTo(note.anchor, match) })
    else elsewhere.push(note)
  }
  return { placed, elsewhere }
}

function moveTo(anchor: NoteAnchor, match: AnchorMatch): NoteAnchor {
  return lastLine(anchor) > anchor.line ? { ...anchor, line: match.line, endLine: match.endLine } : { ...anchor, line: match.line }
}

/**
 * A match good enough to say the commit's line is still in the final content: the same text and most of its context.
 * A range found intact counts its own lines after the first as context that agreed.
 */
export function survives(anchor: NoteAnchor, match: AnchorMatch | null): boolean {
  if (!match) return false
  if (match.kind === 'exact') return true
  const inner = anchoredText(anchor).length - 1
  const intact = inner > 0 && match.endLine - match.line === inner ? inner : 0
  const context = anchor.before.length + anchor.after.length + intact
  return context > 0 && match.contextScore + intact >= Math.ceil(context / 2)
}

export interface ViewAnchor {
  anchor: NoteAnchor
  /** Set when the note stays on the commit's lines. */
  commit?: string
}

export type AnchorResult = ViewAnchor | { error: string }

/**
 * The anchor for a note made on this diff. In commit mode a line that still exists in the final content is anchored
 * there, so the note lives on like any other; a line that is gone later stays on the commit's lines, marked with its sha.
 * Lines of the old side only exist in the branch-wide view.
 */
export function anchorForView(
  view: NoteView,
  side: NoteSide,
  line: number,
  shown: Record<NoteSide, readonly NumberedLine[] | null>,
  finalLines: readonly NumberedLine[] | null,
  endLine = line,
): AnchorResult {
  const lines = shown[side]
  if (!lines) return { error: 'This side has no text lines.' }
  if (view.kind === 'all') return { anchor: createAnchor(lines, line, side, endLine) }
  if (side === 'old') return { error: 'Comment on the new (right-hand) side here, or switch to All changes for base lines.' }
  const anchor = createAnchor(lines, line, 'new', endLine)
  if (view.kind === 'interdiff') return { anchor }
  const match = finalLines ? matchAnchor(anchor, finalLines) : null
  if (finalLines && match && survives(anchor, match)) return { anchor: createAnchor(finalLines, match.line, 'new', match.endLine) }
  return { anchor, commit: view.sha }
}
