import { countNotes, type NoteCounts } from '../review/summary'
import type { RubberduckDb } from './db'
import type { Session } from './schema'

export interface SessionSummary {
  session: Session
  counts: NoteCounts
}

export async function repoHistory(db: RubberduckDb, repoId: string): Promise<SessionSummary[]> {
  const sessions = await db.sessions.where({ repoId }).toArray()
  sessions.sort((a, b) => b.startedAt - a.startedAt)
  return Promise.all(
    sessions.map(async (session) => ({
      session,
      counts: countNotes(await db.notes.where({ sessionId: session.id! }).toArray()),
    })),
  )
}
