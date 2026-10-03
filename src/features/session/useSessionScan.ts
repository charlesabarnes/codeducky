import { useCallback, useEffect, useState } from 'react'
import { gitService } from '../../git/client'
import type { FileChange, FileStats } from '../../git/types'

export interface ScanState {
  files: FileChange[] | null
  stats: Record<string, FileStats>
  error: string | null
  scanning: boolean
  rescan: () => void
}

export function useSessionScan(handle: FileSystemDirectoryHandle, baseSha: string): ScanState {
  const [files, setFiles] = useState<FileChange[] | null>(null)
  const [stats, setStats] = useState<Record<string, FileStats>>({})
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(true)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setScanning(true)
      setError(null)
      try {
        const git = gitService()
        await git.open(handle)
        const changes = await git.changes(baseSha)
        if (cancelled) return
        setFiles(changes)
        const counts = await git.stats(changes)
        if (!cancelled) setStats(counts)
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
  }, [handle, baseSha, generation])

  const rescan = useCallback(() => setGeneration((n) => n + 1), [])
  return { files, stats, error, scanning, rescan }
}
