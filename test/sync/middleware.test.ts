import 'fake-indexeddb/auto'
import { Dexie } from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { pairId } from '../../shared/sync'
import { setChecked } from '../../src/db/checklists'
import { SkelbertDb } from '../../src/db/db'
import { addNote, deleteNote, editNote } from '../../src/db/notes'
import { startNewSession, startOrResumeSession } from '../../src/db/sessions'
import { applyRemote, remoteTransaction } from '../../src/sync/engine'

const opened: SkelbertDb[] = []
const open = (name: string) => {
  const db = new SkelbertDb(name)
  opened.push(db)
  return db
}
afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.delete()))
})

const anchor = { line: 1, side: 'new' as const, text: 'x', before: [], after: [] }
const start = { repoId: 'gh:o/r', branch: 'feat', headSha: 'h', baseSha: 'b' }

describe('sync middleware', () => {
  it('gives new records a string id and a clock, and queues them', async () => {
    const db = open('mw-add')
    const sessionId = await startOrResumeSession(db, start)
    const noteId = await addNote(db, { sessionId, path: 'a.ts', anchor, body: 'hi', severity: 'nit' })
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
    const note = await db.notes.get(noteId)
    expect(note!.changedAt).toBeGreaterThan(0)
    const outbox = await db.outbox.toArray()
    expect(outbox.map((e) => [e.kind, e.id, e.deleted])).toEqual(
      expect.arrayContaining([
        ['sessions', sessionId, false],
        ['notes', noteId, false],
      ]),
    )
  })

  it('advances the clock on every edit, even within the same millisecond', async () => {
    const db = open('mw-edit')
    const id = await addNote(db, { sessionId: 's', path: 'a.ts', anchor, body: 'one', severity: 'nit' })
    const first = (await db.notes.get(id))!.changedAt!
    await editNote(db, id, { body: 'two', severity: 'nit' })
    await editNote(db, id, { body: 'three', severity: 'nit' })
    const third = (await db.notes.get(id))!.changedAt!
    expect(third).toBeGreaterThanOrEqual(first + 2)
    expect((await db.outbox.get(`notes:${id}`))!.changedAt).toBe(third)
  })

  it('turns deletes into outbox tombstones', async () => {
    const db = open('mw-delete')
    const id = await addNote(db, { sessionId: 's', path: 'a.ts', anchor, body: 'x', severity: 'nit' })
    const before = (await db.notes.get(id))!.changedAt!
    await deleteNote(db, id)
    const entry = await db.outbox.get(`notes:${id}`)
    expect(entry).toMatchObject({ deleted: true })
    expect(entry!.changedAt).toBeGreaterThan(before)
  })

  it('queues range deletes and modifies made through collections', async () => {
    const db = open('mw-range')
    await db.notes.bulkAdd([
      { sessionId: 's', path: 'a', anchor, body: '1', severity: 'nit', status: 'open', source: 'me', createdAt: 0, updatedAt: 0 },
      { sessionId: 's', path: 'b', anchor, body: '2', severity: 'nit', status: 'open', source: 'me', createdAt: 0, updatedAt: 0 },
    ])
    await db.outbox.clear()
    await db.notes.where({ sessionId: 's' }).modify({ status: 'resolved' })
    expect((await db.outbox.toArray()).every((e) => !e.deleted)).toBe(true)
    expect(await db.outbox.count()).toBe(2)
    await db.notes.clear()
    expect((await db.outbox.toArray()).map((e) => e.deleted)).toEqual([true, true])
  })

  it('uses [sessionId, key] sync ids for checklist ticks and viewed files', async () => {
    const db = open('mw-pair')
    await setChecked(db, 's1', 'item-1', true)
    await db.fileViews.put({ sessionId: 's1', path: 'src/a.ts', contentHash: 'h', viewed: true })
    const ids = (await db.outbox.toArray()).map((e) => e.id).sort()
    expect(ids).toEqual([pairId('s1', 'item-1'), pairId('s1', 'src/a.ts')].sort())
  })

  it('widens transactions to the outbox and keeps them atomic', async () => {
    const db = open('mw-atomic')
    const first = await startOrResumeSession(db, start)
    await addNote(db, { sessionId: first, path: 'a', anchor, body: 'carry me', severity: 'issue' })
    await db.outbox.clear()
    await startNewSession(db, start)
    const kinds = (await db.outbox.toArray()).map((e) => e.kind).sort()
    expect(kinds).toEqual(['notes', 'sessions', 'sessions'])

    await expect(
      db.transaction('rw', db.notes, async () => {
        await db.notes.add({ sessionId: 's', path: 'z', anchor, body: 'rolled back', severity: 'nit', status: 'open', source: 'me', createdAt: 0, updatedAt: 0 })
        throw new Error('abort')
      }),
    ).rejects.toThrow('abort')
    expect(await db.notes.filter((n) => n.path === 'z').count()).toBe(0)
    expect((await db.outbox.toArray()).map((e) => e.kind).sort()).toEqual(['notes', 'sessions', 'sessions'])
  })

  it('leaves pulled changes alone: their clock is kept and nothing is queued', async () => {
    const db = open('mw-remote')
    await remoteTransaction(db, () =>
      applyRemote(db, {
        kind: 'notes',
        id: 'n1',
        changedAt: 42,
        deleted: false,
        data: { sessionId: 's', path: 'a', anchor, body: 'remote', severity: 'nit', status: 'open', source: 'mcp', createdAt: 1, updatedAt: 1 },
      }),
    )
    expect(await db.notes.get('n1')).toMatchObject({ changedAt: 42, body: 'remote', source: 'mcp' })
    expect(await db.outbox.count()).toBe(0)
  })

  it('does not touch local-only tables', async () => {
    const db = open('mw-local')
    await db.settings.put({ id: 'app', githubPat: 'ghp_secret' })
    await db.repoHandles.put({ repoId: 'gh:o/r', dirHandle: {} as FileSystemDirectoryHandle })
    expect(await db.outbox.count()).toBe(0)
    expect(Dexie.currentTransaction).toBeNull()
  })
})
