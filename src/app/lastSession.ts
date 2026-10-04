import type { CodeDuckyDb } from '../db/db'
import { readStorage, writeStorage } from './storage'

const KEY = 'codeducky.lastSession'

/** Remembers the session this device opened last, for the /last route (the "last session" app shortcut). */
export function rememberSession(sessionId: string): void {
  writeStorage(KEY, sessionId)
}

/**
 * Where /last goes: the session opened last on this device, else the newest session, else the repos page
 * when there are none.
 */
export async function lastSessionPath(db: Pick<CodeDuckyDb, 'sessions'>, remembered = readStorage(KEY)): Promise<string> {
  const session = (remembered ? await db.sessions.get(remembered) : undefined) ?? (await db.sessions.orderBy('startedAt').last())
  return session?.id ? `/sessions/${encodeURIComponent(session.id)}` : '/'
}
