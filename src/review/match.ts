import type { NoteAnchor } from '../db/schema'
import { anchoredText, CONTEXT_LINES, isRange, lastLine } from './anchor'
import { contiguousAfter, contiguousBefore, type NumberedLine } from './lines'

export type MatchKind = 'exact' | 'nearest'

export interface AnchorMatch {
  index: number
  line: number
  /** The last line matched: `line` itself unless the anchor is a range. */
  endLine: number
  kind: MatchKind
  contextScore: number
}

const normalize = (text: string) => text.trim().replace(/\s+/g, ' ')

function contextScore(anchor: NoteAnchor, lines: readonly NumberedLine[], index: number, endIndex: number): number {
  const before = contiguousBefore(lines, index, anchor.before.length)
  const after = contiguousAfter(lines, endIndex, anchor.after.length)
  let score = 0
  for (let k = 1; k <= before.length; k++) {
    if (normalize(before[before.length - k]!.text) === normalize(anchor.before[anchor.before.length - k]!)) score++
  }
  after.forEach((entry, k) => {
    if (normalize(entry.text) === normalize(anchor.after[k]!)) score++
  })
  return score
}

interface Candidate extends AnchorMatch {
  exactText: boolean
  distance: number
}

function better(a: Candidate, b: Candidate): boolean {
  if (a.contextScore !== b.contextScore) return a.contextScore > b.contextScore
  if (a.exactText !== b.exactText) return a.exactText
  return a.distance < b.distance
}

/** Whether `text` reads at `index` onwards on consecutive lines; 'exact' when not even whitespace differs. */
function blockAt(lines: readonly NumberedLine[], index: number, text: readonly string[], targets: readonly string[]): 'exact' | 'loose' | null {
  let exact = true
  for (let k = 0; k < text.length; k++) {
    const entry = lines[index + k]
    if (!entry || entry.line !== lines[index]!.line + k) return null
    if (entry.text !== text[k]) {
      if (normalize(entry.text) !== targets[k]) return null
      exact = false
    }
  }
  return exact ? 'exact' : 'loose'
}

/** The anchored lines read the same, in one piece; the best context agreement wins, then the nearest. */
function matchBlock(anchor: NoteAnchor, lines: readonly NumberedLine[]): AnchorMatch | null {
  const text = anchoredText(anchor)
  const targets = text.map(normalize)
  const blank = targets.every((target) => target === '')
  const fullScore = anchor.before.length + anchor.after.length
  let best: Candidate | null = null
  for (const [index, entry] of lines.entries()) {
    const found = blockAt(lines, index, text, targets)
    if (!found) continue
    const endIndex = index + text.length - 1
    const score = contextScore(anchor, lines, index, endIndex)
    if (blank && score === 0) continue
    const exactText = found === 'exact'
    const candidate: Candidate = {
      index,
      line: entry.line,
      endLine: lines[endIndex]!.line,
      kind: score === fullScore && exactText ? 'exact' : 'nearest',
      contextScore: score,
      exactText,
      distance: Math.abs(entry.line - anchor.line),
    }
    if (!best || better(candidate, best)) best = candidate
  }
  if (!best) return null
  return { index: best.index, line: best.line, endLine: best.endLine, kind: best.kind, contextScore: best.contextScore }
}

/**
 * A range whose inside changed: each end is matched on its own, with the lines inside the range as its inner context.
 * Both ends must be found, in order, on one run of consecutive lines, each agreeing with some of its context.
 */
function matchEnds(anchor: NoteAnchor, lines: readonly NumberedLine[]): AnchorMatch | null {
  const text = anchoredText(anchor)
  const last = text.length - 1
  const first = matchBlock({ line: anchor.line, side: anchor.side, text: text[0]!, before: anchor.before, after: text.slice(1, 1 + CONTEXT_LINES) }, lines)
  const end = matchBlock(
    { line: lastLine(anchor), side: anchor.side, text: text[last]!, before: text.slice(Math.max(0, last - CONTEXT_LINES), last), after: anchor.after },
    lines,
  )
  if (!first || !end || end.line <= first.line) return null
  if (first.contextScore === 0 || end.contextScore === 0) return null
  if (end.index - first.index !== end.line - first.line) return null
  return { index: first.index, line: first.line, endLine: end.line, kind: 'nearest', contextScore: first.contextScore + end.contextScore }
}

/**
 * Finds the anchor's lines in `lines`, which may be a whole file or the sparse lines of a patch side.
 * Candidates must carry the anchor text; the best context agreement wins, then the nearest line.
 * A range is found whole where it is intact, otherwise by its two ends, so it follows lines added or removed inside it.
 */
export function matchAnchor(anchor: NoteAnchor, lines: readonly NumberedLine[]): AnchorMatch | null {
  const block = matchBlock(anchor, lines)
  if (block || !isRange(anchor) || !anchor.rangeText?.length) return block
  return matchEnds(anchor, lines)
}
