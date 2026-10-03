import type { DiffLine, DiffSide } from './hunks'

/** Where the other half of a moved block is. */
export interface MoveTarget {
  path: string
  side: DiffSide
  line: number
}

/** A run of removed (old) or added (new) lines that reappears elsewhere, inclusive line numbers. */
export interface MovedRange {
  side: DiffSide
  start: number
  end: number
  other: MoveTarget
}

export type MovedIndex = Record<string, MovedRange[]>

export interface MoveInput {
  path: string
  lines: readonly DiffLine[]
}

/** Like git's --color-moved: a block needs at least this many non-blank lines… */
export const MIN_MOVED_LINES = 3
/** …and this many letters and digits, so runs of closing braces never count. */
const MIN_ALNUM = 20
/** Lines that occur more often than this are poor block starts (e.g. a common import). */
const MAX_CANDIDATES = 64
/** Above this many changed lines in total, detection is skipped to keep scans fast. */
export const MAX_MOVE_LINES = 200_000

interface Removed {
  path: string
  line: number
  text: string
  /** Index of the run of consecutive removed lines it belongs to. */
  run: number
}

interface Added {
  line: number
  text: string
}

const isBlank = (text: string) => text.trim() === ''
const alnumCount = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, '').length

function runsOf(lines: readonly DiffLine[], kind: 'add' | 'del'): DiffLine[][] {
  const runs: DiffLine[][] = []
  let current: DiffLine[] | null = null
  for (const line of lines) {
    if (line.kind !== kind) {
      if (line.kind === 'context') current = null
      continue
    }
    if (!current) {
      current = []
      runs.push(current)
    }
    current.push(line)
  }
  return runs
}

function collectRemoved(files: readonly MoveInput[]) {
  const removed: Removed[] = []
  const index = new Map<string, number[]>()
  let run = 0
  for (const { path, lines } of files) {
    for (const lineRun of runsOf(lines, 'del')) {
      for (const line of lineRun) {
        const position = removed.length
        removed.push({ path, line: line.oldNo!, text: line.text, run })
        if (isBlank(line.text)) continue
        const positions = index.get(line.text)
        if (positions) positions.push(position)
        else index.set(line.text, [position])
      }
      run++
    }
  }
  return { removed, index }
}

interface Match {
  from: number
  length: number
  nonBlank: number
}

function longestMatch(added: readonly Added[], at: number, removed: readonly Removed[], candidates: readonly number[], used: Uint8Array): Match | null {
  let best: Match | null = null
  for (const from of candidates.slice(0, MAX_CANDIDATES)) {
    let length = 0
    let nonBlank = 0
    while (
      at + length < added.length &&
      from + length < removed.length &&
      !used[from + length] &&
      removed[from + length]!.run === removed[from]!.run &&
      removed[from + length]!.text === added[at + length]!.text
    ) {
      if (!isBlank(added[at + length]!.text)) nonBlank++
      length++
    }
    while (length > 0 && isBlank(added[at + length - 1]!.text)) length--
    if (!best || nonBlank > best.nonBlank) best = { from, length, nonBlank }
  }
  return best
}

function qualifies(added: readonly Added[], at: number, match: Match): boolean {
  if (match.nonBlank < MIN_MOVED_LINES) return false
  let alnum = 0
  for (let k = 0; k < match.length && alnum < MIN_ALNUM; k++) alnum += alnumCount(added[at + k]!.text)
  return alnum >= MIN_ALNUM
}

/**
 * Finds blocks removed in one place and added in another, within a file or across files.
 * Greedy, like git: each added line starts the longest unused identical run of removed lines.
 */
export function detectMovedBlocks(files: readonly MoveInput[]): MovedIndex {
  const total = files.reduce((sum, file) => sum + file.lines.length, 0)
  if (total > MAX_MOVE_LINES) return {}
  const { removed, index } = collectRemoved(files)
  const used = new Uint8Array(removed.length)
  const result: MovedIndex = {}
  const record = (path: string, range: MovedRange) => (result[path] ??= []).push(range)

  for (const { path, lines } of files) {
    for (const run of runsOf(lines, 'add')) {
      const added: Added[] = run.map((line) => ({ line: line.newNo!, text: line.text }))
      let at = 0
      while (at < added.length) {
        const candidates = isBlank(added[at]!.text) ? undefined : index.get(added[at]!.text)
        const match = candidates && longestMatch(added, at, removed, candidates, used)
        if (!match || !qualifies(added, at, match)) {
          at++
          continue
        }
        const source = removed[match.from]!
        const sourceEnd = removed[match.from + match.length - 1]!.line
        const target = added[at]!.line
        record(path, { side: 'new', start: target, end: added[at + match.length - 1]!.line, other: { path: source.path, side: 'old', line: source.line } })
        record(source.path, { side: 'old', start: source.line, end: sourceEnd, other: { path, side: 'new', line: target } })
        used.fill(1, match.from, match.from + match.length)
        at += match.length
      }
    }
  }
  for (const ranges of Object.values(result)) ranges.sort((a, b) => (a.side === b.side ? a.start - b.start : a.side === 'old' ? -1 : 1))
  return result
}

/** The moved range covering a line on one side, if any. */
export function movedAt(ranges: readonly MovedRange[] | undefined, side: DiffSide, line: number): MovedRange | null {
  if (!ranges) return null
  for (const range of ranges) if (range.side === side && line >= range.start && line <= range.end) return range
  return null
}

/** The changed lines, with each stretch of context squeezed to one line so runs stay apart. */
export function changedRuns(lines: readonly DiffLine[]): DiffLine[] {
  const kept: DiffLine[] = []
  for (const line of lines) {
    if (line.kind !== 'context' || kept[kept.length - 1]?.kind !== 'context') kept.push(line)
  }
  return kept
}
