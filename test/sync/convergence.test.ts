import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkedItems, createChecklist, setChecked } from '../../src/db/checklists'
import { CodeDuckyDb } from '../../src/db/db'
import { addNote, deleteNote, editNote, setNoteStatus } from '../../src/db/notes'
import { saveOpenedRepo } from '../../src/db/repos'
import { startOrResumeSession } from '../../src/db/sessions'
import { runSync } from '../../src/sync/engine'
import { SyncController } from '../../src/sync/controller'
import { FakeSyncServer } from '../support/fakeSyncServer'

const opened: { db: CodeDuckyDb; controller: SyncController }[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const { db, controller } of opened.splice(0)) {
    controller.dispose()
    await db.delete()
  }
})

function client(name: string, server: FakeSyncServer) {
  const db = new CodeDuckyDb(name)
  const controller = new SyncController(db, { fetch: server.fetch, listenToBrowser: false, debounceMs: 10_000, intervalMs: 3_600_000 })
  opened.push({ db, controller })
  return { db, controller }
}

const anchor = { line: 1, side: 'new' as const, text: 'x', before: [], after: [] }
const folder = (name: string) => ({ kind: 'directory', name }) as unknown as FileSystemDirectoryHandle
const identity = { owner: 'charlesabarnes', name: 'codeducky', defaultBase: 'main' }

/** Comparable contents of every synced table. */
async function contents(db: CodeDuckyDb) {
  const strip = <T extends object>(rows: T[]) => rows.map((row) => ({ ...row }))
  return {
    repos: strip(await db.repos.orderBy('id').toArray()),
    sessions: strip(await db.sessions.orderBy('id').toArray()),
    notes: strip(await db.notes.orderBy('id').toArray()),
    checklists: strip(await db.checklists.orderBy('id').toArray()),
    checklistState: strip(await db.checklistState.toArray()),
    fileViews: strip(await db.fileViews.toArray()),
  }
}

describe('two clients', () => {
  it('converge after edits on both sides, including offline edits and deletes', async () => {
    const server = new FakeSyncServer()
    const a = client('conv-a', server)
    const b = client('conv-b', server)

    // A has data from before sync existed; signing in uploads it.
    const repoId = await saveOpenedRepo(a.db, folder('codeducky'), identity)
    const sessionId = await startOrResumeSession(a.db, { repoId, branch: 'feat', headSha: 'h', baseSha: 'b' })
    const keep = await addNote(a.db, { sessionId, path: 'src/a.ts', anchor, body: 'keep', severity: 'issue' })
    const doomed = await addNote(a.db, { sessionId, path: 'src/a.ts', anchor, body: 'doomed', severity: 'nit' })
    const listId = await createChecklist(a.db, 'global', { title: 'Before push', items: ['Tests pass'] })
    await a.db.fileViews.put({ sessionId, path: 'src/a.ts', contentHash: 'c', viewed: true })
    expect(await a.controller.signIn('pass', 'A')).toBe('ok')
    expect(server.live('notes')).toHaveLength(2)

    expect(await b.controller.signIn('pass', 'B')).toBe('ok')
    expect(await contents(b.db)).toEqual(await contents(a.db))
    expect(await b.db.repoHandles.count()).toBe(0)

    // B opens its own checkout: it attaches to the synced repo instead of creating a second one.
    expect(await saveOpenedRepo(b.db, folder('codeducky-clone'), identity)).toBe(repoId)
    expect(await b.db.repos.count()).toBe(1)

    // Both go offline and edit.
    server.offline = true
    await editNote(a.db, keep, { body: 'keep (edited on A)', severity: 'blocker' })
    await deleteNote(a.db, doomed)
    const item = (await a.db.checklists.get(listId))!.items[0]!.id
    await setChecked(a.db, sessionId, item, true)
    await new Promise((resolve) => setTimeout(resolve, 2))
    await setNoteStatus(b.db, keep, 'resolved')
    await editNote(b.db, doomed, { body: 'edited on B before A deleted it?', severity: 'nit' })
    const fromB = await addNote(b.db, { sessionId, path: 'src/b.ts', anchor, body: 'new on B', severity: 'suggestion' })
    await a.controller.sync()
    expect(a.controller.getSnapshot().status).toBe('unreachable')
    expect(a.controller.getSnapshot().pending).toBeGreaterThan(0)

    // Back online: sync both, then A again to pick up B's writes.
    server.offline = false
    await a.controller.sync()
    await b.controller.sync()
    await a.controller.sync()

    const [left, right] = [await contents(a.db), await contents(b.db)]
    expect(left).toEqual(right)
    // B's later edits win per record: the status change and the edit to the note A deleted.
    expect(left.notes.find((n) => n.id === keep)).toMatchObject({ status: 'resolved', body: 'keep', severity: 'issue' })
    expect(left.notes.find((n) => n.id === doomed)?.body).toBe('edited on B before A deleted it?')
    expect(left.notes.find((n) => n.id === fromB)?.body).toBe('new on B')
    expect(await checkedItems(b.db, sessionId)).toEqual(new Set([item]))
    expect(await a.db.outbox.count()).toBe(0)
    expect(await b.db.outbox.count()).toBe(0)
  })

  it('propagates a delete made after the last edit', async () => {
    const server = new FakeSyncServer()
    const a = client('del-a', server)
    const b = client('del-b', server)
    await a.controller.signIn('pass', 'A')
    await b.controller.signIn('pass', 'B')
    const id = await addNote(a.db, { sessionId: 's', path: 'x', anchor, body: 'bye', severity: 'nit' })
    await a.controller.sync()
    await b.controller.sync()
    expect(await b.db.notes.get(id)).toBeDefined()

    server.offline = true
    await deleteNote(b.db, id)
    server.offline = false
    await b.controller.sync()
    await a.controller.sync()
    expect(await a.db.notes.get(id)).toBeUndefined()
    expect(server.records().find((c) => c.id === id)).toMatchObject({ deleted: true })
  })

  it('keeps a local delete that is newer than a pulled edit', async () => {
    const server = new FakeSyncServer()
    const a = client('race-a', server)
    const b = client('race-b', server)
    await a.controller.signIn('pass', 'A')
    await b.controller.signIn('pass', 'B')
    const id = await addNote(a.db, { sessionId: 's', path: 'x', anchor, body: 'v1', severity: 'nit' })
    await a.controller.sync()
    await b.controller.sync()

    await editNote(a.db, id, { body: 'v2', severity: 'nit' })
    await a.controller.sync()
    await new Promise((resolve) => setTimeout(resolve, 2))
    await deleteNote(b.db, id)
    // B pulls A's older edit and pushes its newer delete in the same round.
    await b.controller.sync()
    await a.controller.sync()
    expect(await a.db.notes.get(id)).toBeUndefined()
    expect(await b.db.notes.get(id)).toBeUndefined()
  })

  it('parks refused records, and retries or discards them', async () => {
    const server = new FakeSyncServer()
    const a = client('reject-a', server)
    await a.controller.signIn('pass', 'A')
    server.reject = (change) => (change.kind === 'notes' && change.data?.body === 'bad' ? 'not allowed' : null)
    const bad = await addNote(a.db, { sessionId: 's', path: 'x', anchor, body: 'bad', severity: 'nit' })
    const good = await addNote(a.db, { sessionId: 's', path: 'x', anchor, body: 'good', severity: 'nit' })
    await a.controller.sync()
    expect(server.live('notes').map((c) => c.id)).toEqual([good])
    expect(await a.db.rejected.toArray()).toMatchObject([{ id: bad, error: 'not allowed' }])
    expect(a.controller.getSnapshot()).toMatchObject({ rejected: 1, pending: 0 })

    server.reject = () => null
    await a.controller.retryRejected(`notes:${bad}`)
    await a.controller.sync()
    expect(server.live('notes')).toHaveLength(2)
    expect(await a.db.rejected.count()).toBe(0)

    server.reject = () => 'nope'
    await editNote(a.db, bad, { body: 'still bad', severity: 'nit' })
    await a.controller.sync()
    await a.controller.discardRejected(`notes:${bad}`)
    await a.controller.sync()
    expect((await a.db.notes.get(bad))?.body).toBe('bad')
  })

  it('pulls in pages', async () => {
    const server = new FakeSyncServer('pass', 3)
    const a = client('page-a', server)
    const b = client('page-b', server)
    await a.controller.signIn('pass', 'A')
    for (let i = 0; i < 8; i++) await addNote(a.db, { sessionId: 's', path: `f${i}`, anchor, body: String(i), severity: 'nit' })
    await a.controller.sync()
    const result = await runSync(b.db, (request) => Promise.resolve(server.handle(request)))
    expect(result.pulled).toBe(8)
    expect(await b.db.notes.count()).toBe(8)
  })

  it('stops syncing when the token is revoked and keeps local data', async () => {
    const server = new FakeSyncServer()
    const a = client('revoke-a', server)
    await a.controller.signIn('pass', 'A')
    server.revokeAll()
    await addNote(a.db, { sessionId: 's', path: 'x', anchor, body: 'kept', severity: 'nit' })
    await a.controller.sync()
    expect(a.controller.getSnapshot().auth).toBe('expired')
    expect(await a.db.notes.count()).toBe(1)
    expect(await a.db.outbox.count()).toBe(1)

    expect(await a.controller.signIn('wrong', 'A')).toBe('invalid')
    expect(await a.controller.signIn('pass', 'A')).toBe('ok')
    expect(server.live('notes')).toHaveLength(1)
  })

  it('signs out without losing local data or unsent changes', async () => {
    const server = new FakeSyncServer()
    const a = client('signout-a', server)
    await a.controller.signIn('pass', 'A')
    server.offline = true
    await addNote(a.db, { sessionId: 's', path: 'x', anchor, body: 'unsent', severity: 'nit' })
    await a.controller.signOut()
    expect(a.controller.getSnapshot().auth).toBe('signedOut')
    expect(await a.db.outbox.count()).toBe(1)
    server.offline = false
    await a.controller.signIn('pass', 'A')
    expect(server.live('notes')).toHaveLength(1)
  })

  it('syncs on its own shortly after a local write', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const server = new FakeSyncServer()
    const db = new CodeDuckyDb('auto-a')
    const controller = new SyncController(db, { fetch: server.fetch, listenToBrowser: false, debounceMs: 50 })
    opened.push({ db, controller })
    await controller.signIn('pass', 'A')
    await addNote(db, { sessionId: 's', path: 'x', anchor, body: 'auto', severity: 'nit' })
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(60)
      expect(server.live('notes')).toHaveLength(1)
    })
  })
})

describe('app start', () => {
  it('syncs as soon as a signed-in device starts', async () => {
    const server = new FakeSyncServer()
    const a = client('start-a', server)
    await a.controller.signIn('pass', 'A')
    await addNote(a.db, { sessionId: 's', path: 'x', anchor, body: 'from A', severity: 'nit' })
    await a.controller.sync()

    const b = client('start-b', server)
    await b.controller.signIn('pass', 'B')
    b.controller.dispose()
    await addNote(a.db, { sessionId: 's', path: 'y', anchor, body: 'later', severity: 'nit' })
    await a.controller.sync()

    const reopened = new SyncController(b.db, { fetch: server.fetch, listenToBrowser: false })
    opened.push({ db: b.db, controller: reopened })
    await reopened.start()
    await vi.waitFor(async () => expect(await b.db.notes.count()).toBe(2))
  })
})
