import { sessionPath } from '../../../shared/links'
import type { CodeDuckyDb } from '../../db/db'
import { openPatchSession } from '../../db/patchSessions'

/** What the file picker and the manifest's file handlers accept. */
export const PATCH_ACCEPT = { 'text/x-diff': ['.diff'], 'text/x-patch': ['.patch'] } as const
export const PATCH_EXTENSIONS = Object.values(PATCH_ACCEPT).flat().join(',')

const MAX_PATCH_BYTES = 20 * 1024 * 1024

type Readable = Pick<File, 'name' | 'size' | 'text'>

/** Opens each file as a patch session and returns the last one's id. */
export async function openPatchFiles(db: CodeDuckyDb, files: readonly Readable[]): Promise<string | null> {
  let last: string | null = null
  for (const file of files) {
    if (file.size > MAX_PATCH_BYTES) throw new Error(`${file.name} is larger than ${MAX_PATCH_BYTES / 1024 / 1024} MB.`)
    last = await openPatchSession(db, { name: file.name, text: await file.text() })
  }
  return last
}

/** Where the app goes after files were opened with it: the session, or the repos page with the reason it failed. */
export interface PatchLaunch {
  to: string
  patchError?: string
}

export async function openLaunchedFiles(db: CodeDuckyDb, handles: readonly FileSystemHandle[]): Promise<PatchLaunch> {
  try {
    const files = await Promise.all(
      handles.filter((handle): handle is FileSystemFileHandle => handle.kind === 'file').map((handle) => handle.getFile()),
    )
    const sessionId = await openPatchFiles(db, files)
    return sessionId ? { to: sessionPath(sessionId) } : { to: '/', patchError: 'No file was opened.' }
  } catch (error) {
    return { to: '/', patchError: error instanceof Error ? error.message : String(error) }
  }
}
