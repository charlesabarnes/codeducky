import { useEffect } from 'react'
import type { FileChange } from '../../git/types'
import { reanchorSession } from '../notes/reanchorSession'

export function useReanchor(sessionId: string, files: FileChange[] | null): void {
  useEffect(() => {
    if (!files) return
    let cancelled = false
    reanchorSession(sessionId, files, () => cancelled).catch((error: unknown) => console.error('Re-anchoring failed', error))
    return () => {
      cancelled = true
    }
  }, [sessionId, files])
}
