import { useCallback, useEffect, useState } from 'react'
import { gitService } from '../../git/client'
import type { FileChange, FileStats } from '../../git/types'
import { connect } from '../../github/connect'
import { githubBaseChanges } from '../../github/remoteBase'
import type { RepoRef } from '../../github/types'

export interface ScanState {
  files: FileChange[] | null
  stats: Record<string, FileStats>
  error: string | null
  scanning: boolean
  rescan: () => void
}

/** `githubRepo` is set when the session's base came from GitHub, so base files may need fetching from there. */
export function useSessionScan(handle: FileSystemDirectoryHandle, baseSha: string, githubRepo: RepoRef | null): ScanState {
  const [files, setFiles] = useState<FileChange[] | null>(null)
  const [stats, setStats] = useState<Record<string, FileStats>>({})
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(true)
  const [generation, setGeneration] = useState(0)
  const owner = githubRepo?.owner ?? null
  const name = githubRepo?.name ?? null

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setScanning(true)
      setError(null)
      try {
        const git = gitService()
        await git.open(handle)
        const changes = owner && name ? await scanGitHubBase({ owner, name }, baseSha) : await git.changes(baseSha)
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
  }, [handle, baseSha, owner, name, generation])

  const rescan = useCallback(() => setGeneration((n) => n + 1), [])
  return { files, stats, error, scanning, rescan }
}

async function scanGitHubBase(ref: RepoRef, baseSha: string): Promise<FileChange[]> {
  const conn = await connect(ref)
  if (!conn) throw new Error('This session diffs against a GitHub base, but no GitHub token is set in Settings.')
  return githubBaseChanges(gitService(), conn.gh, conn.ref, baseSha)
}
