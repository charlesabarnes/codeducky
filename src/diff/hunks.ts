import { diffLines } from 'diff'

export type LineKind = 'context' | 'add' | 'del'
export type DiffSide = 'old' | 'new'

export interface DiffLine {
  kind: LineKind
  text: string
  oldNo: number | null
  newNo: number | null
  noNewline?: boolean
}

export type DiffSegment =
  | { type: 'lines'; lines: DiffLine[] }
  | { type: 'gap'; id: number; lines: DiffLine[] }

export interface SplitRow {
  left: DiffLine | null
  right: DiffLine | null
}

export const DEFAULT_CONTEXT = 3
const MIN_GAP = 4
const DIFF_TIMEOUT_MS = 2000

function splitValue(value: string): { text: string; noNewline: boolean }[] {
  if (value === '') return []
  const parts = value.split('\n')
  const endsWithNewline = parts[parts.length - 1] === ''
  if (endsWithNewline) parts.pop()
  return parts.map((text, index) => ({
    text: text.endsWith('\r') ? text.slice(0, -1) : text,
    noNewline: !endsWithNewline && index === parts.length - 1,
  }))
}

function wholeFileChange(oldText: string, newText: string) {
  return [
    { value: oldText, removed: true, added: false },
    { value: newText, removed: false, added: true },
  ]
}

export function buildLines(oldText: string, newText: string): DiffLine[] {
  const changes = diffLines(oldText, newText, { timeout: DIFF_TIMEOUT_MS }) ?? wholeFileChange(oldText, newText)
  const lines: DiffLine[] = []
  let oldNo = 1
  let newNo = 1
  for (const change of changes) {
    const kind: LineKind = change.added ? 'add' : change.removed ? 'del' : 'context'
    for (const { text, noNewline } of splitValue(change.value)) {
      lines.push({
        kind,
        text,
        oldNo: kind === 'add' ? null : oldNo++,
        newNo: kind === 'del' ? null : newNo++,
        ...(noNewline ? { noNewline } : {}),
      })
    }
  }
  return lines
}

export function countChanges(oldText: string, newText: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of buildLines(oldText, newText)) {
    if (line.kind === 'add') additions++
    else if (line.kind === 'del') deletions++
  }
  return { additions, deletions }
}

export function lineOn(line: DiffLine, side: DiffSide): number | null {
  if (side === 'old') return line.kind === 'add' ? null : line.oldNo
  return line.kind === 'del' ? null : line.newNo
}

export const lineKey = (side: DiffSide, line: number) => `${side}:${line}`

export function buildSegments(
  lines: DiffLine[],
  context = DEFAULT_CONTEXT,
  pinned: ReadonlySet<string> = new Set(),
): DiffSegment[] {
  const visible = new Array<boolean>(lines.length).fill(false)
  const isPinned = (line: DiffLine) =>
    (['old', 'new'] as const).some((side) => {
      const number = lineOn(line, side)
      return number !== null && pinned.has(lineKey(side, number))
    })
  lines.forEach((line, index) => {
    if (pinned.size > 0 && isPinned(line)) visible[index] = true
    if (line.kind === 'context') return
    const from = Math.max(0, index - context)
    const to = Math.min(lines.length - 1, index + context)
    for (let i = from; i <= to; i++) visible[i] = true
  })

  const segments: DiffSegment[] = []
  let gapId = 0
  let start = 0
  while (start < lines.length) {
    const shown = visible[start]
    let end = start
    while (end < lines.length && visible[end] === shown) end++
    const run = lines.slice(start, end)
    const last = segments[segments.length - 1]
    if (!shown && run.length >= MIN_GAP) {
      segments.push({ type: 'gap', id: gapId++, lines: run })
    } else if (last?.type === 'lines') {
      last.lines.push(...run)
    } else {
      segments.push({ type: 'lines', lines: run })
    }
    start = end
  }
  return segments
}

export function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.kind === 'context') {
      rows.push({ left: line, right: line })
      i++
      continue
    }
    const dels: DiffLine[] = []
    const adds: DiffLine[] = []
    while (i < lines.length && lines[i]!.kind === 'del') dels.push(lines[i++]!)
    while (i < lines.length && lines[i]!.kind === 'add') adds.push(lines[i++]!)
    for (let row = 0; row < Math.max(dels.length, adds.length); row++) {
      rows.push({ left: dels[row] ?? null, right: adds[row] ?? null })
    }
  }
  return rows
}

export interface GapExpansion {
  top: number
  bottom: number
}

export type VisibleBlock =
  | { type: 'lines'; lines: DiffLine[] }
  | { type: 'gap'; id: number; hidden: number }

export function visibleBlocks(segments: DiffSegment[], expanded: ReadonlyMap<number, GapExpansion>): VisibleBlock[] {
  const blocks: VisibleBlock[] = []
  const pushLines = (lines: DiffLine[]) => {
    if (lines.length === 0) return
    const last = blocks[blocks.length - 1]
    if (last?.type === 'lines') last.lines = [...last.lines, ...lines]
    else blocks.push({ type: 'lines', lines })
  }
  for (const segment of segments) {
    if (segment.type === 'lines') {
      pushLines(segment.lines)
      continue
    }
    const { top = 0, bottom = 0 } = expanded.get(segment.id) ?? {}
    const total = segment.lines.length
    const shownTop = Math.min(top, total)
    const shownBottom = Math.min(bottom, total - shownTop)
    pushLines(segment.lines.slice(0, shownTop))
    const hidden = total - shownTop - shownBottom
    if (hidden > 0) blocks.push({ type: 'gap', id: segment.id, hidden })
    pushLines(segment.lines.slice(total - shownBottom))
  }
  return blocks
}

export function limitBlocks(blocks: VisibleBlock[], maxLines: number): { blocks: VisibleBlock[]; remaining: number } {
  const limited: VisibleBlock[] = []
  let budget = maxLines
  let remaining = 0
  for (const block of blocks) {
    if (block.type === 'gap') {
      if (budget > 0) limited.push(block)
      continue
    }
    const shown = block.lines.slice(0, Math.max(budget, 0))
    if (shown.length > 0) limited.push({ type: 'lines', lines: shown })
    remaining += block.lines.length - shown.length
    budget -= shown.length
  }
  return { blocks: limited, remaining }
}
