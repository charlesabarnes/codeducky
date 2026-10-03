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

const NO_MOVES: MovedIndex = {}

/** Lists the source's files, then analyses them (line counts, moved blocks); runs again on rescan or a new source. */
export function useSessionScan(source: DiffSource): ScanState {
  const [files, setFiles] = useState<FileChange[] | null>(null)
  const [stats, setStats] = useState<Record<string, FileStats>>({})
  const [moved, setMoved] = useState<MovedIndex>(NO_MOVES)
  const [renamesLimited, setRenamesLimited] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(true)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setScanning(true)
      setError(null)
      try {
        const listed = await source.listFiles()
        if (cancelled) return
        setFiles(listed.files)
        setRenamesLimited(listed.renamesLimited)
        const analysis = await source.analyze(listed.files)
        if (cancelled) return
        setStats(analysis.stats)
        setMoved(analysis.moved)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setScanning(false)
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [source, generation])

  const rescan = useCallback(() => setGeneration((n) => n + 1), [])
  return { files, stats, moved, renamesLimited, error, scanning, rescan }
}
