import { useEffect } from 'react'
import { db } from '../../db/db'
import type { FileChange, FileStats } from '../../git/types'
import { sameSummary, summarizeFiles } from '../../review/fileSummary'

/** Records the finished scan's file list on the session, so get_review_context can describe the diff. */
export function useFileSummary(sessionId: string, files: FileChange[] | null, stats: Record<string, FileStats>, scanning: boolean) {
  useEffect(() => {
    if (scanning || !files) return
    const summary = summarizeFiles(files, stats)
    void db.sessions.get(sessionId).then((session) => {
      if (session && !sameSummary(session.files, summary)) return db.sessions.update(sessionId, { files: summary })
    })
  }, [sessionId, files, stats, scanning])
}
