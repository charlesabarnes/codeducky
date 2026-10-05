import { useCallback, useMemo, useState } from 'react'
import { isPatchSession, type Session } from '../../db/schema'
import type { BranchCommit, FileChange } from '../../git/types'
import type { GitHubClient } from '../../github/client'
import type { PrSnapshot } from '../../github/prDiff'
import { extendRange, rangeEnds, rangeOf, stepCommit, type CommitRange } from '../../review/commitRange'
import type { SinceEntry, SinceKind } from '../../review/lastLook'
import { sideLines, type NumberedLine } from '../../review/lines'
import type { NoteView } from '../../review/viewNotes'
import type { DiffSource } from '../session/source'
import { useSessionScan, type ScanState } from '../session/useSessionScan'
import { localCommitSource, localReviewedLoader, prCommitSource, prReviewedLoader, sinceSource } from './modeSources'
import { useBranchCommits, type CommitsState } from './useBranchCommits'
import { useLastLook, type LastLookState } from './useLastLook'

/** What the session shows: the whole branch, what changed since your last look, or a commit or range of commits. */
export type ReviewMode = { kind: 'all' } | { kind: 'since' } | { kind: 'commits'; fromSha: string; toSha: string }

export interface FileBadge {
  kind: SinceKind
  label: string
  title: string
}

const BADGES: Record<SinceKind, Omit<FileBadge, 'kind'>> = {
  new: { label: 'new', title: 'New since last look: you have not viewed this file yet. Showing its full diff.' },
  changed: { label: 'changed', title: 'Changed since your last look. Showing only what changed since then.' },
  missing: {
    label: 'full',
    title: 'Changed since your last look, but the version you reviewed is not on this device. Showing the full diff.',
  },
  unchanged: { label: 'same', title: 'Unchanged since your last look.' },
}

interface Options {
  session: Session
  /** The session's own (branch-wide) source and its scan. */
  source: DiffSource
  scan: ScanState
  dirHandle: FileSystemDirectoryHandle | null
  pr: { gh: GitHubClient; snapshot: PrSnapshot } | null
  /** Bumped on rescan, so the commit list reloads too. */
  generation: number
}

export interface ReviewModeApi {
  mode: ReviewMode
  setMode: (mode: ReviewMode) => void
  lastLook: LastLookState
  showUnchanged: boolean
  setShowUnchanged: (show: boolean) => void
  commits: CommitsState
  /** The picked commits, while in commit mode and the list has them. */
  range: CommitRange | null
  /** Picks one commit, or with `extend` grows the picked range to it. */
  pickCommit: (index: number, extend?: boolean) => void
  /** Steps to the next or previous commit (All changes before the first and after the last). */
  stepCommits: (delta: 1 | -1) => ReviewMode
  /** What the file list and diff show. */
  display: ScanState & { source: DiffSource }
  badges: ReadonlyMap<string, FileBadge> | null
  noteViewFor: (path: string) => NoteView
  /** The new side of a file in the branch-wide diff, to anchor commit-mode notes on the final content. */
  finalLines: (path: string) => Promise<NumberedLine[] | null>
  /** The branch-wide change for a path: viewed state is per file for the whole branch. */
  branchChange: (path: string) => FileChange | null
}

const entriesKey = (entries: readonly SinceEntry[]) => entries.map((entry) => `${entry.change.path}@${entry.kind}:${entry.change.oldOid}:${entry.change.newOid}`).join('|')

export function useReviewMode({ session, source, scan, dirHandle, pr, generation }: Options): ReviewModeApi {
  const [mode, setMode] = useState<ReviewMode>({ kind: 'all' })
  const [showUnchanged, setShowUnchanged] = useState(false)
  const gh = pr?.gh ?? null
  const ref = pr?.snapshot.ref ?? null
  const head = pr?.snapshot.pull.headSha ?? null
  const number = pr?.snapshot.pull.number ?? 0

  // A patch is one fixed diff: no commits, and no earlier look to compare with.
  const fixed = isPatchSession(session)
  const lastLook = useLastLook(session, fixed ? null : scan.files, gh && ref && head ? { kind: 'pr', gh, ref, head } : { kind: 'local' })
  const commits = useBranchCommits(
    gh && ref && head ? { kind: 'pr', gh, ref, number, head } : { kind: 'local', baseSha: session.baseSha },
    !fixed && scan.files !== null,
    String(generation),
  )
  const list = useMemo<readonly BranchCommit[]>(() => (commits.status === 'ready' ? commits.commits : []), [commits])
  const range = mode.kind === 'commits' ? rangeOf(list, mode.fromSha, mode.toSha) : null

  const loader = useMemo(() => (gh && ref ? prReviewedLoader(gh, ref) : localReviewedLoader()), [gh, ref])
  const entries = lastLook.entries
  const sinceKey = mode.kind === 'since' && entries ? entriesKey(entries) : null
  const sinceSrc = useMemo(
    () => (sinceKey !== null && entries ? sinceSource(source, entries, loader, scan.stats) : null),
    // Rebuilt only when the classification itself changes, not on every live query result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sinceKey, source, loader, scan.stats],
  )
  const ends = range ? rangeEnds(list, range) : null
  const commitSrc = useMemo(() => {
    if (!ends) return null
    if (gh && ref) return ends.base ? prCommitSource(gh, ref, ends.base, ends.head) : null
    return dirHandle ? localCommitSource(ends.base, ends.head) : null
  }, [ends?.base, ends?.head, gh, ref, dirHandle]) // eslint-disable-line react-hooks/exhaustive-deps

  const modeSource = mode.kind === 'since' ? sinceSrc : mode.kind === 'commits' ? commitSrc : null
  const modeScan = useSessionScan(modeSource)

  const display = useMemo(() => {
    if (mode.kind === 'all' || !modeSource) {
      if (mode.kind === 'all') return { ...scan, source }
      const problem =
        mode.kind !== 'commits'
          ? null
          : commits.status === 'error'
            ? `Could not list the commits: ${commits.message}`
            : commits.status === 'ready' && !commitSrc
              ? 'Those commits are no longer on this branch. Pick another, or go back to All changes.'
              : null
      if (problem) return { ...modeScan, files: null, scanning: false, error: problem, source }
      // The mode is still preparing (classifying files or loading commits).
      return { ...modeScan, files: null, scanning: true, source }
    }
    if (mode.kind === 'since' && modeScan.files && entries && !showUnchanged) {
      const hidden = new Set(entries.filter((entry) => entry.kind === 'unchanged').map((entry) => entry.change.path))
      return { ...modeScan, files: modeScan.files.filter((file) => !hidden.has(file.path)), source: modeSource }
    }
    return { ...modeScan, source: modeSource }
  }, [mode.kind, modeSource, modeScan, scan, source, entries, showUnchanged, commits, commitSrc])

  const badges = useMemo(() => {
    if (mode.kind !== 'since' || !entries) return null
    return new Map(entries.map((entry) => [entry.change.path, { kind: entry.kind, ...BADGES[entry.kind] }]))
  }, [mode.kind, entries])

  const sinceKinds = useMemo(() => new Map(entries?.map((entry) => [entry.change.path, entry.kind]) ?? []), [entries])
  const toSha = mode.kind === 'commits' ? mode.toSha : null
  const noteViewFor = useCallback(
    (path: string): NoteView => {
      if (toSha) return { kind: 'commit', sha: toSha }
      if (mode.kind === 'since' && sinceKinds.get(path) === 'changed') return { kind: 'interdiff' }
      return { kind: 'all' }
    },
    [mode.kind, toSha, sinceKinds],
  )

  const branchFiles = scan.files
  const branchChange = useCallback((path: string) => branchFiles?.find((file) => file.path === path) ?? null, [branchFiles])
  const finalLines = useCallback(
    async (path: string) => {
      const change = branchChange(path)
      if (!change || change.status === 'deleted') return null
      return sideLines((await source.contents(change)).new)
    },
    [branchChange, source],
  )

  const pickCommit = useCallback(
    (index: number, extend = false) => {
      const next = extend ? extendRange(range, index) : { from: index, to: index }
      const first = list[next.from]
      const last = list[next.to]
      if (first && last) setMode({ kind: 'commits', fromSha: first.sha, toSha: last.sha })
    },
    [range, list],
  )
  const stepCommits = (delta: 1 | -1): ReviewMode => {
    const next = stepCommit(range, list.length, delta)
    const first = next ? list[next.from] : undefined
    const value: ReviewMode = next && first ? { kind: 'commits', fromSha: first.sha, toSha: first.sha } : { kind: 'all' }
    setMode(value)
    return value
  }

  return {
    mode,
    setMode,
    lastLook,
    showUnchanged,
    setShowUnchanged,
    commits,
    range,
    pickCommit,
    stepCommits,
    display,
    badges,
    noteViewFor,
    finalLines,
    branchChange,
  }
}
