import 'fake-indexeddb/auto'
import { Dexie } from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { SkelbertDb } from '../../src/db/db'
import { repoHistory } from '../../src/db/history'
import { addNote, setNoteStatus } from '../../src/db/notes'
import { startNewSession, startOrResumeSession } from '../../src/db/sessions'

const opened: Dexie[] = []
const track = <T extends Dexie>(db: T) => {
  opened.push(db)
  return db
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.delete()))
})

const start = { repoId: 'r1', branch: 'feature', headSha: 'h1', baseSha: 'b1' }
const anchor = { line: 3, side: 'new' as const, text: 'x', before: [], after: [] }

describe('sessions', () => {
  it('carries open notes into a new session on the same branch', async () => {
    const db = track(new SkelbertDb('carry'))
    const first = await startOrResumeSession(db, start)
    const keep = await addNote(db, { sessionId: first, path: 'a.ts', anchor, body: 'keep', severity: 'issue' })
    const done = await addNote(db, { sessionId: first, path: 'a.ts', anchor, body: 'done', severity: 'nit' })
    await setNoteStatus(db, done, 'resolved')

    const second = await startNewSession(db, { ...start, headSha: 'h2' })
    expect(second).not.toBe(first)
    expect((await db.sessions.get(first))?.status).toBe('archived')
    const carried = await db.notes.where({ sessionId: second }).toArray()
    expect(carried).toHaveLength(1)
    expect(carried[0]).toMatchObject({ body: 'keep', carriedFrom: keep, status: 'open', anchor })
    expect(await db.notes.where({ sessionId: first }).count()).toBe(2)

    const other = await startOrResumeSession(db, { ...start, branch: 'other' })
    expect(await db.notes.where({ sessionId: other }).count()).toBe(0)

    const history = await repoHistory(db, 'r1')
    expect(history.map((entry) => [entry.session.id, entry.counts.byStatus.open, entry.counts.byStatus.resolved])).toEqual([
      [other, 0, 0],
      [second, 1, 0],
      [first, 1, 1],
    ])
  })

  it('resumes the active session without copying notes again', async () => {
    const db = track(new SkelbertDb('resume'))
    const first = await startOrResumeSession(db, start)
    await addNote(db, { sessionId: first, path: 'a.ts', anchor, body: 'n', severity: 'nit' })
    expect(await startOrResumeSession(db, { ...start, headSha: 'h2' })).toBe(first)
    expect(await db.notes.count()).toBe(1)
  })

  it('migrates version 1 severities', async () => {
    const legacy = track(new Dexie('migrate'))
    legacy.version(1).stores({ notes: '++id, sessionId, [sessionId+path], status' })
    await legacy.table('notes').bulkAdd([
      { sessionId: 's1', path: 'a', severity: 'info' },
      { sessionId: 's1', path: 'b', severity: 'warning' },
      { sessionId: 's1', path: 'c', severity: 'blocker' },
    ])
    legacy.close()

    const db = track(new SkelbertDb('migrate'))
    const notes = await db.notes.toArray()
    expect(notes.map((note) => note.severity)).toEqual(['suggestion', 'issue', 'blocker'])
    expect(notes.every((note) => typeof note.createdAt === 'number')).toBe(true)
  })
})
