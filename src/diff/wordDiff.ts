import { diffWordsWithSpace } from 'diff'
import type { DiffLine } from './hunks'

/** A half-open character range [start, end) of a line's text. */
export interface CharRange {
  start: number
  end: number
}

export interface WordChanges {
  old: CharRange[]
  new: CharRange[]
}

/** Lines longer than this are not word-diffed: the cost grows quickly and the result is rarely readable. */
export const MAX_WORD_DIFF_CHARS = 1000
/** Below this share of unchanged characters, highlighting words only adds noise. */
const MIN_UNCHANGED_SHARE = 0.3

/**
 * Pairs removed lines with added lines the way GitHub does: within each run of changes, the n-th
 * removed line goes with the n-th added line. Split view puts the same pairs side by side.
 */
export function pairChangedLines(lines: readonly DiffLine[], skip?: (line: DiffLine) => boolean): Map<DiffLine, DiffLine> {
  const partners = new Map<DiffLine, DiffLine>()
  let i = 0
  while (i < lines.length) {
    if (lines[i]!.kind === 'context') {
      i++
      continue
    }
    const dels: DiffLine[] = []
    const adds: DiffLine[] = []
    // Filtered while collecting: spreading a huge run into splice() overflows the stack.
    const keep = (line: DiffLine) => !skip?.(line)
    for (; i < lines.length && lines[i]!.kind === 'del'; i++) if (keep(lines[i]!)) dels.push(lines[i]!)
    for (; i < lines.length && lines[i]!.kind === 'add'; i++) if (keep(lines[i]!)) adds.push(lines[i]!)
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      partners.set(dels[k]!, adds[k]!)
      partners.set(adds[k]!, dels[k]!)
    }
  }
  return partners
}

/** The changed words between two versions of a line, or null when they should not be highlighted. */
export function wordChanges(oldText: string, newText: string): WordChanges | null {
  if (oldText === newText) return null
  if (oldText.length > MAX_WORD_DIFF_CHARS || newText.length > MAX_WORD_DIFF_CHARS) return null
  const result: WordChanges = { old: [], new: [] }
  let oldAt = 0
  let newAt = 0
  let unchanged = 0
  const push = (ranges: CharRange[], start: number, end: number) => {
    const last = ranges[ranges.length - 1]
    if (last && last.end === start) last.end = end
    else ranges.push({ start, end })
  }
  for (const part of diffWordsWithSpace(oldText, newText)) {
    const length = part.value.length
    if (part.removed) {
      push(result.old, oldAt, oldAt + length)
      oldAt += length
    } else if (part.added) {
      push(result.new, newAt, newAt + length)
      newAt += length
    } else {
      if (part.value.trim()) unchanged += length
      oldAt += length
      newAt += length
    }
  }
  const longest = Math.max(oldText.trim().length, newText.trim().length)
  if (longest === 0 || unchanged / longest < MIN_UNCHANGED_SHARE) return null
  return { old: bridgeSpaces(oldText, result.old), new: bridgeSpaces(newText, result.new) }
}

/** Joins changed words separated only by whitespace, so `a b` → `x y` reads as one change. */
function bridgeSpaces(text: string, ranges: CharRange[]): CharRange[] {
  const joined: CharRange[] = []
  for (const range of ranges) {
    const last = joined[joined.length - 1]
    if (last && text.slice(last.end, range.start).trim() === '') last.end = range.end
    else joined.push({ ...range })
  }
  return joined
}

/**
 * Word changes for a line's side of a pair, memoised per line object: lines are only diffed when
 * they render, so a huge file costs nothing for the lines that stay off screen. Lines that `skip`
 * accepts (moved blocks) are never paired.
 */
export function createWordDiffer(lines: readonly DiffLine[], skip?: (line: DiffLine) => boolean) {
  const partners = pairChangedLines(lines, skip)
  const cache = new WeakMap<DiffLine, CharRange[] | null>()
  return (line: DiffLine): CharRange[] | null => {
    if (cache.has(line)) return cache.get(line)!
    const partner = partners.get(line)
    let ranges: CharRange[] | null = null
    if (partner) {
      const [del, add] = line.kind === 'del' ? [line, partner] : [partner, line]
      const changes = wordChanges(del.text, add.text)
      cache.set(del, changes?.old ?? null)
      cache.set(add, changes?.new ?? null)
      ranges = (line.kind === 'del' ? changes?.old : changes?.new) ?? null
    }
    cache.set(line, ranges)
    return ranges
  }
}

export type WordDiffer = ReturnType<typeof createWordDiffer>

export interface Piece {
  text: string
  color?: string
  changed: boolean
}

/**
 * Splits syntax-highlighted tokens (or the plain text) at the edges of the changed ranges, so the
 * word highlight layers over the token colours without touching them.
 */
export function layerRanges(
  tokens: readonly { content: string; color?: string }[] | null,
  text: string,
  ranges: readonly CharRange[] | null,
): Piece[] {
  const source = tokens ?? [{ content: text }]
  if (!ranges || ranges.length === 0) return source.map((token) => ({ text: token.content, color: token.color, changed: false }))
  const pieces: Piece[] = []
  let offset = 0
  let r = 0
  for (const token of source) {
    const end = offset + token.content.length
    let at = offset
    while (at < end) {
      while (r < ranges.length && ranges[r]!.end <= at) r++
      const range = ranges[r]
      let next: number
      let changed: boolean
      if (!range || range.start >= end) {
        next = end
        changed = false
      } else if (range.start > at) {
        next = range.start
        changed = false
      } else {
        next = Math.min(range.end, end)
        changed = true
      }
      pieces.push({ text: token.content.slice(at - offset, next - offset), color: token.color, changed })
      at = next
    }
    offset = end
  }
  return pieces
}
