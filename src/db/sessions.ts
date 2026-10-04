import { errorMessage } from '../github/errors'
import { carryOverNotes } from '../review/carryOver'
import type { RubberduckDb } from './db'
import { recordArchivedReview } from './fileViews'
import { isPrSession, type Session } from './schema'

export interface SessionStart {
  repoId: string
  branch: string
  headSha: string
  baseSha: string
}

export async function activeSession(db: RubberduckDb, repoId: string, branch: string): Promise<Session | undefined> {
  const sessions = await db.sessions.where({ repoId, branch }).filter((s) => s.status === 'active' && !isPrSession(s)).sortBy('startedAt')
  return sessions[sessions.length - 1]
}

export type GitHubBaseResolver = () => Promise<Pick<Session, 'headSha' | 'baseSha' | 'githubBase'>>

/**
 * Resumes the active session for the branch, or starts one. A session on a GitHub base keeps it, with the
 * merge base recomputed by `resolveGitHubBase`; if that fails, it goes back to the local base with a notice.
 */
export async function startOrResumeSession(
  db: RubberduckDb,
  start: SessionStart,
  resolveGitHubBase?: GitHubBaseResolver,
): Promise<string> {
  const previous = await activeSession(db, start.repoId, start.branch)
  let base: Partial<Session> = {
    headSha: start.headSha,
    baseSha: start.baseSha,
    baseSource: 'local',
    githubBase: undefined,
    baseNotice: undefined,
  }
  if (previous?.baseSource === 'github') {
    try {
      if (!resolveGitHubBase) throw new Error('No GitHub connection.')
      base = { ...(await resolveGitHubBase()), baseSource: 'github', baseNotice: undefined }
    } catch (error) {
      base.baseNotice = `Could not get the base from GitHub, so this session uses your local base. ${errorMessage(error)}`
    }
  }
  return db.transaction('rw', db.sessions, db.notes, async () => {
    const current = await activeSession(db, start.repoId, start.branch)
    if (current?.id !== undefined) {
      await db.sessions.update(current.id, base)
      return current.id
    }
    return createSession(db, start)
  })
}

export async function startNewSession(db: RubberduckDb, start: SessionStart): Promise<string> {
  return db.transaction('rw', db.sessions, db.notes, db.fileViews, async () => {
    const archiving = await db.sessions
      .where({ repoId: start.repoId, branch: start.branch })
      .filter((session) => !isPrSession(session) && session.status === 'active')
      .toArray()
    for (const session of archiving) {
      await recordArchivedReview(db, session)
      await db.sessions.update(session.id!, { status: 'archived' })
    }
    return createSession(db, start)
  })
}

export async function latestSession(db: RubberduckDb, repoId: string, branch: string): Promise<Session | undefined> {
  const sessions = await db.sessions.where({ repoId, branch }).filter((s) => !isPrSession(s)).sortBy('startedAt')
  return sessions[sessions.length - 1]
}

async function createSession(db: RubberduckDb, start: SessionStart): Promise<string> {
  const previous = await latestSession(db, start.repoId, start.branch)
  const now = Date.now()
  const sessionId = (await db.sessions.add({
    ...start,
    baseSource: 'local',
    startedAt: Math.max(now, (previous?.startedAt ?? 0) + 1),
    status: 'active',
  })) as string
  if (previous?.id !== undefined) {
    const notes = await db.notes.where({ sessionId: previous.id }).toArray()
    await db.notes.bulkAdd(carryOverNotes(notes, sessionId, now))
  }
  return sessionId
}
