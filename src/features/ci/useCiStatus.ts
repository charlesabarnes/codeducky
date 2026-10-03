import { useEffect, useMemo, useState } from 'react'
import type { Repo } from '../../db/schema'
import { gitService } from '../../git/client'
import type { FileChange } from '../../git/types'
import { fetchCi, groupAnnotations, pollDelayMs, summarize, type AnnotationsByFile, type CiSnapshot, type CiSummary } from '../../github/ci'
import { connect } from '../../github/connect'
import { errorMessage } from '../../github/errors'
import type { CheckRun } from '../../github/types'

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

/** Paths with annotations whose working-tree blob is not the one in the checked commit. */
async function dirtyPaths(snapshot: CiSnapshot, files: readonly FileChange[]): Promise<Set<string>> {
  const byPath = new Map(files.map((file) => [file.path, file]))
  const paths = [...new Set(snapshot.annotations.map((annotation) => annotation.path))].filter((path) => byPath.has(path))
  if (paths.length === 0) return new Set()
  const oids = await gitService().oidsAt(snapshot.sha, paths)
  return new Set(paths.filter((path) => oids[path] !== byPath.get(path)!.newOid))
}

/**
 * Check runs and annotations for the local HEAD, when it is on GitHub and a token is set.
 * Polls with backoff while any check is still running; a rescan starts over.
 */
export function useCiStatus(repo: Pick<Repo, 'owner' | 'name'>, files: FileChange[] | null, generation: number): CiView {
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
        const { headSha } = await gitService().info()
        const snapshot = await fetchCi(conn.gh, conn.ref, headSha)
        if (cancelled) return
        if (!snapshot) return setStatus({ kind: 'not-pushed', sha: headSha })
        const dirty = await dirtyPaths(snapshot, files)
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
  }, [owner, name, files, generation])

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
