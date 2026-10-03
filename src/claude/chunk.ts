import { buildLines, buildSegments, type DiffLine } from '../diff/hunks'
import type { ChangeStatus } from '../git/types'
import type { ReviewChunk } from './types'

export interface ChunkLimits {
  /** Files whose diff renders to at most this many lines are sent whole, unchanged lines included. */
  wholeFileLines: number
  /** Unchanged lines kept around each change when a file is too large to send whole. */
  context: number
  /** Upper bound on rendered lines per request. */
  maxLines: number
}

export const DEFAULT_LIMITS: ChunkLimits = { wholeFileLines: 1200, context: 25, maxLines: 800 }

export interface ChunkInput {
  path: string
  status: ChangeStatus
  oldText: string | null
  newText: string | null
}

const MARKERS = { add: '+', del: '-', context: ' ' } as const

export function renderLines(lines: readonly DiffLine[]): string {
  const width = Math.max(1, ...lines.map((line) => String(Math.max(line.oldNo ?? 0, line.newNo ?? 0)).length))
  const column = (value: number | null) => (value === null ? '' : String(value)).padStart(width)
  return lines
    .map((line) => `${MARKERS[line.kind]}${column(line.kind === 'add' ? null : line.oldNo)} ${column(line.kind === 'del' ? null : line.newNo)} | ${line.text}`)
    .join('\n')
}

function hunkHeader(lines: readonly DiffLine[]): string {
  const range = (values: number[]) => (values.length ? `${values[0]}-${values[values.length - 1]}` : 'none')
  const olds = lines.filter((line) => line.kind !== 'add').map((line) => line.oldNo!)
  const news = lines.filter((line) => line.kind !== 'del').map((line) => line.newNo!)
  return `@@ old ${range(olds)}, new ${range(news)} @@`
}

function slices(lines: DiffLine[], size: number): DiffLine[][] {
  const result: DiffLine[][] = []
  for (let start = 0; start < lines.length; start += size) result.push(lines.slice(start, start + size))
  return result
}

/** Splits one file's change into review requests: whole file when small, otherwise hunks with context grouped under a size cap. */
export function chunkFile(input: ChunkInput, limits: ChunkLimits = DEFAULT_LIMITS): ReviewChunk[] {
  const lines = buildLines(input.oldText ?? '', input.newText ?? '')
  if (!lines.some((line) => line.kind !== 'context')) return []
  const base = { path: input.path, status: input.status }

  if (lines.length <= limits.wholeFileLines) {
    return [{ ...base, part: 1, parts: 1, wholeFile: true, diff: renderLines(lines) }]
  }

  const hunks = buildSegments(lines, limits.context)
    .filter((segment) => segment.type === 'lines')
    .flatMap((segment) => slices(segment.lines, limits.maxLines))

  const groups: DiffLine[][][] = []
  let size = 0
  for (const hunk of hunks) {
    const current = groups[groups.length - 1]
    if (current && size + hunk.length <= limits.maxLines) {
      current.push(hunk)
      size += hunk.length
    } else {
      groups.push([hunk])
      size = hunk.length
    }
  }

  return groups.map((group, index) => ({
    ...base,
    part: index + 1,
    parts: groups.length,
    wholeFile: false,
    diff: group.map((hunk) => `${hunkHeader(hunk)}\n${renderLines(hunk)}`).join('\n'),
  }))
}
