import type { GitHubClient } from './client'
import type { CheckAnnotation, CheckRun, RepoRef } from './types'

export type CiState = 'pass' | 'fail' | 'pending' | 'none'

export interface CiSummary {
  state: CiState
  passed: number
  failed: number
  pending: number
  skipped: number
}

const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'stale'])
const SKIPPED = new Set(['skipped', 'neutral'])

export const isPending = (run: CheckRun) => run.status !== 'completed'
export const isFailed = (run: CheckRun) => !isPending(run) && FAILED.has(run.conclusion ?? '')

export function runState(run: CheckRun): 'pass' | 'fail' | 'pending' | 'skipped' {
  if (isPending(run)) return 'pending'
  if (isFailed(run)) return 'fail'
  return SKIPPED.has(run.conclusion ?? '') ? 'skipped' : 'pass'
}

/** Failing beats pending beats passing, as on GitHub's status icon. */
export function summarize(runs: readonly CheckRun[]): CiSummary {
  const summary: CiSummary = { state: 'none', passed: 0, failed: 0, pending: 0, skipped: 0 }
  for (const run of runs) {
    const state = runState(run)
    if (state === 'pass') summary.passed++
    else if (state === 'fail') summary.failed++
    else if (state === 'pending') summary.pending++
    else summary.skipped++
  }
  if (summary.failed > 0) summary.state = 'fail'
  else if (summary.pending > 0) summary.state = 'pending'
  else if (runs.length > 0) summary.state = 'pass'
  return summary
}

export interface CiSnapshot {
  sha: string
  runs: CheckRun[]
  annotations: CheckAnnotation[]
}

const ANNOTATION_CONCURRENCY = 4

/** Check runs for the commit and every run's annotations; null when GitHub does not have the commit. */
export async function fetchCi(gh: GitHubClient, ref: RepoRef, sha: string): Promise<CiSnapshot | null> {
  const runs = await gh.checkRuns(ref, sha)
  if (!runs) return null
  const queue = runs.filter((run) => run.annotationsCount > 0)
  const annotations: CheckAnnotation[][] = []
  const worker = async () => {
    for (let run = queue.shift(); run; run = queue.shift()) annotations.push(await gh.checkRunAnnotations(ref, run.id))
  }
  await Promise.all(Array.from({ length: Math.min(ANNOTATION_CONCURRENCY, queue.length) }, worker))
  const order = new Map(runs.map((run, index) => [run.id, index]))
  const flat = annotations.flat().sort((a, b) => order.get(a.checkRunId)! - order.get(b.checkRunId)! || a.startLine - b.startLine)
  return { sha, runs, annotations: flat }
}

/** The wait before the next poll while checks are pending: 10 s, 20 s, 40 s, then every 60 s. */
export function pollDelayMs(attempt: number): number {
  return Math.min(10_000 * 2 ** attempt, 60_000)
}

export interface AnnotationsByFile {
  byPath: Map<string, CheckAnnotation[]>
  /** Annotations on paths that are not in the change set. */
  elsewhere: CheckAnnotation[]
}

export function groupAnnotations(annotations: readonly CheckAnnotation[], paths: ReadonlySet<string>): AnnotationsByFile {
  const byPath = new Map<string, CheckAnnotation[]>()
  const elsewhere: CheckAnnotation[] = []
  for (const annotation of annotations) {
    if (!paths.has(annotation.path)) {
      elsewhere.push(annotation)
      continue
    }
    byPath.set(annotation.path, [...(byPath.get(annotation.path) ?? []), annotation])
  }
  return { byPath, elsewhere }
}

export interface FileForAnnotations {
  /** Lines in the working-tree version of the file; null when it was deleted or is not text. */
  newLineCount: number | null
  /** False when the working tree differs from the commit the checks ran on, so line numbers may be off. */
  matchesCheckedCommit: boolean
}

export interface UnplacedAnnotation {
  annotation: CheckAnnotation
  reason: string
}

export interface PlacedAnnotations {
  /** New-side line → annotations ending on it (GitHub shows multi-line annotations at their last line). */
  byLine: Map<number, CheckAnnotation[]>
  unplaced: UnplacedAnnotation[]
}

/** Puts each annotation on its line of the new side, or says why it cannot go there. */
export function placeAnnotations(annotations: readonly CheckAnnotation[], file: FileForAnnotations): PlacedAnnotations {
  const placed: PlacedAnnotations = { byLine: new Map(), unplaced: [] }
  for (const annotation of annotations) {
    const line = annotation.endLine || annotation.startLine
    let reason: string | null = null
    if (file.newLineCount === null) reason = 'The file has no text in the working tree'
    else if (!file.matchesCheckedCommit) reason = 'The file changed since the checked commit'
    else if (line < 1 || line > file.newLineCount) reason = line < 1 ? 'Not on a line' : `Line ${line} is past the end of the file`
    if (reason) {
      placed.unplaced.push({ annotation, reason })
      continue
    }
    placed.byLine.set(line, [...(placed.byLine.get(line) ?? []), annotation])
  }
  return placed
}
