import { hashBlob } from '../git/hash'
import { parsePatchSet } from '../review/patchSet'
import { patchSessionId } from '../sync/ids'
import type { CodeDuckyDb } from './db'
import type { Repo, Session } from './schema'

/** Patch sessions belong to no repo; this stands in for one wherever a session needs it. */
export const PATCH_REPO_ID = 'patch'

export interface PatchInput {
  name: string
  text: string
}

/**
 * Opens a patch file as a review session on this device: the active session of the same patch if there is one, so
 * its notes are kept, else a new one. The session's branch is the file name and its head the patch's hash.
 */
export async function openPatchSession(db: CodeDuckyDb, { name, text }: PatchInput, now = Date.now()): Promise<string> {
  let files: number
  try {
    files = parsePatchSet(text).length
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (files === 0) throw new Error(`${name} has no file changes to review. Is it a .diff or .patch file?`)
  const digest = await hashBlob(new TextEncoder().encode(text))
  return db.transaction('rw', db.sessions, db.patches, async () => {
    const existing = await db.sessions
      .where({ repoId: PATCH_REPO_ID })
      .filter((session) => session.headSha === digest && session.status === 'active')
      .first()
    if (existing?.id) {
      await db.sessions.update(existing.id, { branch: name })
      return existing.id
    }
    const id = patchSessionId()
    await db.patches.put({ sessionId: id, name, text })
    await db.sessions.add({
      id,
      repoId: PATCH_REPO_ID,
      branch: name,
      headSha: digest,
      baseSha: digest,
      baseSource: 'local',
      source: 'patch',
      startedAt: now,
      status: 'active',
    })
    return id
  })
}

export function patchSessions(db: CodeDuckyDb): Promise<Session[]> {
  return db.sessions.where({ repoId: PATCH_REPO_ID }).reverse().sortBy('startedAt')
}

/** Removes a patch session with its file and everything recorded on it. */
export function removePatchSession(db: CodeDuckyDb, sessionId: string): Promise<void> {
  return db.transaction('rw', [db.sessions, db.patches, db.notes, db.fileViews, db.checklistState], async () => {
    await db.notes.where({ sessionId }).delete()
    await db.fileViews.where({ sessionId }).delete()
    await db.checklistState.where({ sessionId }).delete()
    await db.patches.delete(sessionId)
    await db.sessions.delete(sessionId)
  })
}

/** The repo a patch session is shown under: named after the file, with no remote, folder or base. */
export const patchRepo = (session: Pick<Session, 'branch' | 'startedAt'>): Repo & { id: string } => ({
  id: PATCH_REPO_ID,
  owner: '',
  name: session.branch,
  folderName: '',
  baseBranch: '',
  checklistIds: [],
  lastOpenedAt: session.startedAt,
})
