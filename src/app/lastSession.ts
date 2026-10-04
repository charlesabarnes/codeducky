import type { CodeDuckyDb } from '../db/db'
import { readStorage, writeStorage } from './storage'

const KEY = 'codeducky.lastSession'

/** Remembers the session this device opened last, for the /last route (the "last session" app shortcut). */
export function rememberSession(sessionId: string): void {
  writeStorage(KEY, sessionId)
}

/**
 * Where /last goes: the session opened last on this device, else the newest session, else the repos page.
 * Sessions whose repo is gone cannot open, so they are skipped.
 */
export async function lastSessionPath(db: Pick<CodeDuckyDb, 'sessions' | 'repos'>, remembered = readStorage(KEY)): Promise<string> {
  const repoIds = new Set(await db.repos.toCollection().primaryKeys())
  const opens = (session: { id?: string; repoId: string } | undefined) => !!session?.id && repoIds.has(session.repoId)
  const last = remembered ? await db.sessions.get(remembered) : undefined
  const session = opens(last) ? last : (await db.sessions.orderBy('startedAt').reverse().toArray()).find(opens)
  return session?.id ? `/sessions/${encodeURIComponent(session.id)}` : '/'
}
