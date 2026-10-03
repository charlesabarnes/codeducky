import type { NoteAnchor } from '../db/schema'
import { contiguousAfter, contiguousBefore, type NumberedLine } from './lines'

export type MatchKind = 'exact' | 'nearest'

export interface AnchorMatch {
  index: number
  line: number
  kind: MatchKind
  contextScore: number
}

const normalize = (text: string) => text.trim().replace(/\s+/g, ' ')

function contextScore(anchor: NoteAnchor, lines: readonly NumberedLine[], index: number): number {
  const before = contiguousBefore(lines, index, anchor.before.length)
  const after = contiguousAfter(lines, index, anchor.after.length)
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

/**
 * Finds the anchor's line in `lines`, which may be a whole file or the sparse lines of a patch side.
 * Candidates must carry the anchor text; the best context agreement wins, then the nearest line.
 */
export function matchAnchor(anchor: NoteAnchor, lines: readonly NumberedLine[]): AnchorMatch | null {
  const target = normalize(anchor.text)
  const fullScore = anchor.before.length + anchor.after.length
  let best: Candidate | null = null
  for (const [index, entry] of lines.entries()) {
    if (entry.text !== anchor.text && normalize(entry.text) !== target) continue
    const score = contextScore(anchor, lines, index)
    if (target === '' && score === 0) continue
    const exactText = entry.text === anchor.text
    const candidate: Candidate = {
      index,
      line: entry.line,
      kind: score === fullScore && exactText ? 'exact' : 'nearest',
      contextScore: score,
      exactText,
      distance: Math.abs(entry.line - anchor.line),
    }
    if (!best || better(candidate, best)) best = candidate
  }
  if (!best) return null
  return { index: best.index, line: best.line, kind: best.kind, contextScore: best.contextScore }
}
