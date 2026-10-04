import type { BranchCommit } from '../git/types'

/** A contiguous run of the branch's commits, as indexes into the list (oldest first); from === to for one commit. */
export interface CommitRange {
  from: number
  to: number
}

/** The two commits the range diffs: the first commit's first parent (null for a root commit), and the last commit. */
export function rangeEnds(commits: readonly BranchCommit[], range: CommitRange): { base: string | null; head: string } {
  const first = commits[range.from]
  const last = commits[range.to]
  if (!first || !last) throw new Error('That commit is no longer on the branch.')
  return { base: first.parents[0] ?? null, head: last.sha }
}

/**
 * The next view when stepping commit by commit: from All changes (null) forward goes to the first commit and back
 * goes to the last; past either end it returns to All changes. A range steps as a whole from its edge.
 */
export function stepCommit(range: CommitRange | null, count: number, delta: 1 | -1): CommitRange | null {
  if (count === 0) return null
  if (!range) {
    const index = delta > 0 ? 0 : count - 1
    return { from: index, to: index }
  }
  const index = delta > 0 ? range.to + 1 : range.from - 1
  if (index < 0 || index >= count) return null
  return { from: index, to: index }
}

/** Shift-click: extends the range to include `index`, keeping it contiguous. */
export function extendRange(range: CommitRange | null, index: number): CommitRange {
  if (!range) return { from: index, to: index }
  return { from: Math.min(range.from, index), to: Math.max(range.to, index) }
}

export const isSingle = (range: CommitRange) => range.from === range.to

export const shortSha = (sha: string) => sha.slice(0, 7)

export const summaryOf = (commit: Pick<BranchCommit, 'message'>) => commit.message.split('\n', 1)[0] ?? ''

/** e.g. "abc1234 Fix the retry loop", or "3 commits, abc1234..def5678". */
export function describeRange(commits: readonly BranchCommit[], range: CommitRange): string {
  const first = commits[range.from]
  const last = commits[range.to]
  if (!first || !last) return ''
  if (isSingle(range)) return `${shortSha(first.sha)} ${summaryOf(first)}`
  return `${range.to - range.from + 1} commits, ${shortSha(first.sha)}..${shortSha(last.sha)}`
}

/** Finds a range again by its commits' shas after the list reloads; null when they are gone. */
export function rangeOf(commits: readonly BranchCommit[], fromSha: string, toSha: string): CommitRange | null {
  const from = commits.findIndex((commit) => commit.sha === fromSha)
  const to = commits.findIndex((commit) => commit.sha === toSha)
  return from >= 0 && to >= from ? { from, to } : null
}
