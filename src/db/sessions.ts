import type { SkelbertDb } from './db'
import type { Session } from './schema'

export interface SessionStart {
  repoId: number
  branch: string
  headSha: string
  baseSha: string
}

export async function activeSession(db: SkelbertDb, repoId: number, branch: string): Promise<Session | undefined> {
  const sessions = await db.sessions.where({ repoId, branch }).filter((s) => s.status === 'active').sortBy('startedAt')
  return sessions[sessions.length - 1]
}

export async function startOrResumeSession(db: SkelbertDb, start: SessionStart): Promise<number> {
  return db.transaction('rw', db.sessions, async () => {
    const current = await activeSession(db, start.repoId, start.branch)
    if (current?.id !== undefined) {
      await db.sessions.update(current.id, { headSha: start.headSha, baseSha: start.baseSha })
      return current.id
    }
    return createSession(db, start)
  })
}

export async function startNewSession(db: SkelbertDb, start: SessionStart): Promise<number> {
  return db.transaction('rw', db.sessions, async () => {
    await db.sessions
      .where({ repoId: start.repoId, branch: start.branch })
      .modify((session) => {
        session.status = 'archived'
      })
    return createSession(db, start)
  })
}

function createSession(db: SkelbertDb, start: SessionStart): Promise<number> {
  return db.sessions.add({
    ...start,
    baseSource: 'local',
    startedAt: Date.now(),
    status: 'active',
  }) as Promise<number>
}
