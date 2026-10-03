import { useEffect, useState } from 'react'
import type { FileChange, FileContents } from '../../git/types'
import type { DiffSource } from './source'

const LARGE_FILE_LIMIT = 50 * 1024 * 1024

export function useFileContents(source: DiffSource, change: FileChange | null, generation: number) {
  const [state, setState] = useState<{ key: string; contents: FileContents | null; error: string | null } | null>(null)
  const [largeAllowed, setLargeAllowed] = useState<string | null>(null)
  const key = change ? `${generation}:${change.path}:${change.oldOid}:${change.newOid}` : ''
  const allowLarge = change !== null && largeAllowed === change.path

  useEffect(() => {
    if (!change) return
    let cancelled = false
    source
      .contents(change, allowLarge ? LARGE_FILE_LIMIT : undefined)
      .then((contents) => !cancelled && setState({ key, contents, error: null }))
      .catch(
        (err: unknown) =>
          !cancelled && setState({ key, contents: null, error: err instanceof Error ? err.message : String(err) }),
      )
    return () => {
      cancelled = true
    }
  }, [source, change, key, allowLarge])

  const current = state?.key === key ? state : null
  return {
    contents: current?.contents ?? null,
    error: current?.error ?? null,
    loading: change !== null && current === null,
    loadLarge: () => change && setLargeAllowed(change.path),
  }
}
