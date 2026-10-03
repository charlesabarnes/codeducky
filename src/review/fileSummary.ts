import type { SessionFile } from '../db/schema'
import type { FileChange, FileStats } from '../git/types'

/** Keeps the synced session record well under the server's record size limit. */
export const MAX_SUMMARY_FILES = 1000

export function summarizeFiles(files: readonly FileChange[], stats: Record<string, FileStats>): SessionFile[] {
  return files.slice(0, MAX_SUMMARY_FILES).map((file) => {
    const counts = stats[file.path]
    const entry: SessionFile = { path: file.path, status: file.status }
    if (counts && 'additions' in counts) {
      entry.additions = counts.additions
      entry.deletions = counts.deletions
    } else if (counts && 'binary' in counts) entry.binary = true
    return entry
  })
}

const key = (file: SessionFile) => [file.path, file.status, file.additions ?? '', file.deletions ?? '', file.binary ?? ''].join('\u0000')

export function sameSummary(a: readonly SessionFile[] | undefined, b: readonly SessionFile[]): boolean {
  return a !== undefined && a.length === b.length && a.every((file, index) => key(file) === key(b[index]!))
}
