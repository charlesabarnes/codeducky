import { buildLines, type DiffLine } from '../diff/hunks'
import { changedRuns, detectMovedBlocks, MAX_MOVE_LINES, type MovedIndex, type MoveInput } from '../diff/moved'
import { readFileContents } from './contents'
import type { GitContext } from './context'
import type { FileChange, FileContents, FileSide, FileStats } from './types'

export interface ChangeAnalysis {
  stats: Record<string, FileStats>
  /** Blocks moved within or across files, keyed by path. */
  moved: MovedIndex
}

const text = (side: FileSide | null) => (side?.kind === 'text' ? side.text : '')

function count(lines: readonly DiffLine[]): FileStats {
  let additions = 0
  let deletions = 0
  for (const line of lines) {
    if (line.kind === 'add') additions++
    else if (line.kind === 'del') deletions++
  }
  return { additions, deletions }
}

/** Line counts for every file and moved blocks across the change set, from one read of each file. */
export async function analyzeChanges(
  ctx: GitContext,
  changes: readonly FileChange[],
  maxBytes?: number,
  read: (ctx: GitContext, change: FileChange, maxBytes?: number) => Promise<FileContents> = readFileContents,
): Promise<ChangeAnalysis> {
  const stats: Record<string, FileStats> = {}
  const changed: MoveInput[] = []
  let changedLines = 0
  for (const change of changes) {
    const contents = await read(ctx, change, maxBytes)
    const sides = [contents.old, contents.new]
    if (sides.some((side) => side?.kind === 'binary')) {
      stats[change.path] = { binary: true }
      continue
    }
    if (sides.some((side) => side?.kind === 'too-large')) {
      stats[change.path] = { tooLarge: true }
      continue
    }
    const lines = buildLines(text(contents.old), text(contents.new))
    const fileStats = count(lines)
    stats[change.path] = fileStats
    if (!('additions' in fileStats)) continue
    changedLines += fileStats.additions + fileStats.deletions
    if (changedLines <= MAX_MOVE_LINES && fileStats.additions + fileStats.deletions > 0) {
      changed.push({ path: change.path, lines: changedRuns(lines) })
    }
  }
  return { stats, moved: changedLines <= MAX_MOVE_LINES ? detectMovedBlocks(changed) : {} }
}
