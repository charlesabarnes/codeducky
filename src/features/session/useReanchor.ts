import { useEffect } from 'react'
import type { FileChange } from '../../git/types'
import { reanchorSession } from '../notes/reanchorSession'
import type { DiffSource } from './source'

export function useReanchor(sessionId: string, files: FileChange[] | null, source: DiffSource): void {
  useEffect(() => {
    if (!files) return
    let cancelled = false
    reanchorSession(sessionId, files, (change) => source.contents(change), () => cancelled).catch((error: unknown) =>
      console.error('Re-anchoring failed', error),
    )
    return () => {
      cancelled = true
    }
  }, [sessionId, files, source])
}
