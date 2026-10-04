import { useCallback, useEffect, useState } from 'react'
import type { MovedIndex } from '../../diff/moved'
import type { FileChange, FileStats } from '../../git/types'
import type { DiffSource } from './source'

export interface ScanState {
  files: FileChange[] | null
  stats: Record<string, FileStats>
  moved: MovedIndex
  /** Rename detection only paired identical files: the change set was too large to compare contents. */
  renamesLimited: boolean
  error: string | null
  scanning: boolean
  rescan: () => void
}

interface Scanned {
  source: DiffSource
  files: FileChange[] | null
  stats: Record<string, FileStats>
  moved: MovedIndex
  renamesLimited: boolean
  error: string | null
  done: boolean
}

const NO_MOVES: MovedIndex = {}
const NO_STATS: Record<string, FileStats> = {}

/**
 * Lists the source's files, then analyses them (line counts, moved blocks); runs again on rescan or a new source.
 * Results always belong to the current source: after a switch nothing shows until the new source has listed.
 * A null source scans nothing.
 */
export function useSessionScan(source: DiffSource | null): ScanState {
  const [scanned, setScanned] = useState<Scanned | null>(null)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (!source) return
    let cancelled = false
    const update = (patch: Partial<Scanned>) =>
      !cancelled &&
      setScanned((current) => ({
        ...(current?.source === source ? current : { files: null, stats: NO_STATS, moved: NO_MOVES, renamesLimited: false, error: null, done: false }),
        source,
        ...patch,
      }))
    const run = async () => {
      update({ error: null, done: false })
      try {
        const listed = await source.listFiles()
        update({ files: listed.files, renamesLimited: listed.renamesLimited })
        if (cancelled) return
        const analysis = await source.analyze(listed.files)
        update({ stats: analysis.stats, moved: analysis.moved })
      } catch (err) {
        update({ error: err instanceof Error ? err.message : String(err) })
      } finally {
        update({ done: true })
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [source, generation])

  const rescan = useCallback(() => setGeneration((n) => n + 1), [])
  const current = source && scanned?.source === source ? scanned : null
  return {
    files: current?.files ?? null,
    stats: current?.stats ?? NO_STATS,
    moved: current?.moved ?? NO_MOVES,
    renamesLimited: current?.renamesLimited ?? false,
    error: current?.error ?? null,
    scanning: source !== null && !current?.done,
    rescan,
  }
}
