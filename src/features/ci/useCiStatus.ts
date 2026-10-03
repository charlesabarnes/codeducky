import { useEffect, useMemo, useState } from 'react'
import type { Repo } from '../../db/schema'
import type { FileChange } from '../../git/types'
import { fetchCi, groupAnnotations, pollDelayMs, summarize, type AnnotationsByFile, type CiSnapshot, type CiSummary } from '../../github/ci'
import { connect } from '../../github/connect'
import { errorMessage } from '../../github/errors'
import type { CheckRun } from '../../github/types'
import type { DiffSource } from '../session/source'

export type CiStatus =
  /** No GitHub remote or no token: nothing to show. */
  | { kind: 'off' }
  | { kind: 'loading' }
  | { kind: 'not-pushed'; sha: string }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; snapshot: CiSnapshot; dirty: ReadonlySet<string>; checkedAt: number }

export interface CiView {
  status: CiStatus
  summary: CiSummary | null
  runs: ReadonlyMap<number, CheckRun>
  annotations: AnnotationsByFile
  /** Paths whose working-tree content differs from the commit the checks ran on. */
  dirty: ReadonlySet<string>
}

const NO_PATHS: ReadonlySet<string> = new Set()

/**
 * Check runs and annotations for the source's head commit (local HEAD or the PR head), when it is on GitHub and a token is set.
 * Polls with backoff while any check is still running; a rescan starts over.
 */
export function useCiStatus(repo: Pick<Repo, 'owner' | 'name'>, source: DiffSource, files: FileChange[] | null, generation: number): CiView {
  const [status, setStatus] = useState<CiStatus>({ kind: 'loading' })
  const { owner, name } = repo

  useEffect(() => {
    if (!files) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    const poll = async () => {
      try {
        const conn = await connect({ owner, name })
        if (!conn) return !cancelled && setStatus({ kind: 'off' })
        const headSha = await source.ciHead()
        const snapshot = await fetchCi(conn.gh, conn.ref, headSha)
        if (cancelled) return
        if (!snapshot) return setStatus({ kind: 'not-pushed', sha: headSha })
        const dirty = await source.dirtyPaths(snapshot, files)
        if (cancelled) return
        setStatus({ kind: 'ready', snapshot, dirty, checkedAt: Date.now() })
        if (snapshot.runs.some((run) => run.status !== 'completed')) timer = setTimeout(poll, pollDelayMs(attempt++))
      } catch (error) {
        if (!cancelled) setStatus({ kind: 'error', message: errorMessage(error) })
      }
    }
    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [owner, name, source, files, generation])

  return useMemo(() => {
    const snapshot = status.kind === 'ready' ? status.snapshot : null
    const paths = new Set(files?.map((file) => file.path))
    return {
      status,
      summary: snapshot ? summarize(snapshot.runs) : null,
      runs: new Map(snapshot?.runs.map((run) => [run.id, run])),
      annotations: groupAnnotations(snapshot?.annotations ?? [], paths),
      dirty: status.kind === 'ready' ? status.dirty : NO_PATHS,
    }
  }, [status, files])
}
