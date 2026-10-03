import { carryOverNotes } from '../review/carryOver'
import type { SkelbertDb } from './db'
import type { Session } from './schema'

export interface SessionStart {
  repoId: string
  branch: string
  headSha: string
  baseSha: string
}

export async function activeSession(db: SkelbertDb, repoId: string, branch: string): Promise<Session | undefined> {
  const sessions = await db.sessions.where({ repoId, branch }).filter((s) => s.status === 'active').sortBy('startedAt')
  return sessions[sessions.length - 1]
}

export async function startOrResumeSession(db: SkelbertDb, start: SessionStart): Promise<string> {
  return db.transaction('rw', db.sessions, db.notes, async () => {
    const current = await activeSession(db, start.repoId, start.branch)
    if (current?.id !== undefined) {
      await db.sessions.update(current.id, {
        headSha: start.headSha,
        baseSha: start.baseSha,
        baseSource: 'local',
        githubBase: undefined,
      })
      return current.id
    }
    return createSession(db, start)
  })
}

export async function startNewSession(db: SkelbertDb, start: SessionStart): Promise<string> {
  return db.transaction('rw', db.sessions, db.notes, async () => {
    await db.sessions
      .where({ repoId: start.repoId, branch: start.branch })
      .modify((session) => {
        session.status = 'archived'
      })
    return createSession(db, start)
  })
}

export async function latestSession(db: SkelbertDb, repoId: string, branch: string): Promise<Session | undefined> {
  const sessions = await db.sessions.where({ repoId, branch }).sortBy('startedAt')
  return sessions[sessions.length - 1]
}

async function createSession(db: SkelbertDb, start: SessionStart): Promise<string> {
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
