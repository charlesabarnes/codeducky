import 'fake-indexeddb/auto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkedItems, createChecklist, setChecked } from '../../src/db/checklists'
import { SkelbertDb } from '../../src/db/db'
import { addNote, deleteNote, editNote, setNoteStatus } from '../../src/db/notes'
import { saveOpenedRepo } from '../../src/db/repos'
import { startOrResumeSession } from '../../src/db/sessions'
import { SyncController } from '../../src/sync/controller'
import { startServer } from '../support/realServer'

const PASSPHRASE = 'integration passphrase'
let BASE = ''
let stop = () => {}

beforeAll(async () => {
  ;({ base: BASE, stop } = await startServer(PASSPHRASE))
})

afterAll(() => stop())

/** A fetch that can be cut off, standing in for a device going offline. */
function device(name: string) {
  const link = { online: true }
  const db = new SkelbertDb(name)
  const flaky: typeof fetch = (input, init) => (link.online ? fetch(input, init) : Promise.reject(new TypeError('Failed to fetch')))
  const controller = new SyncController(db, { baseUrl: BASE, fetch: flaky, listenToBrowser: false, debounceMs: 60_000, intervalMs: 3_600_000 })
  return { db, controller, link }
}

async function snapshot(db: SkelbertDb) {
  return {
    repos: await db.repos.orderBy('id').toArray(),
    sessions: await db.sessions.orderBy('id').toArray(),
    notes: await db.notes.orderBy('id').toArray(),
    checklists: await db.checklists.orderBy('id').toArray(),
    checklistState: await db.checklistState.toArray(),
    fileViews: await db.fileViews.toArray(),
  }
}

const anchor = { line: 4, side: 'new' as const, text: 'const x = 1', before: [], after: [] }
const folder = (name: string) => ({ kind: 'directory', name }) as unknown as FileSystemDirectoryHandle

describe('sync against the real server', () => {
  it('two devices converge, including offline edits and deletes', async () => {
    const a = device('int-a')
    const b = device('int-b')
    try {
      const identity = { owner: 'charlesabarnes', name: 'skelbert', defaultBase: 'main' }
      const repoId = await saveOpenedRepo(a.db, folder('skelbert'), identity)
      const sessionId = await startOrResumeSession(a.db, { repoId, branch: 'phase7', headSha: 'h', baseSha: 'b' })
      const n1 = await addNote(a.db, { sessionId, path: 'server/app.ts', anchor, body: 'check auth', severity: 'issue' })
      const n2 = await addNote(a.db, { sessionId, path: 'server/app.ts', anchor, body: 'nit', severity: 'nit' })
      const listId = await createChecklist(a.db, 'global', { title: 'Push', items: ['Tests'] })
      expect(await a.controller.signIn('wrong', 'A')).toBe('invalid')
      expect(await a.controller.signIn(PASSPHRASE, 'Device A')).toBe('ok')
      expect(await b.controller.signIn(PASSPHRASE, 'Device B')).toBe('ok')
      expect(await snapshot(b.db)).toEqual(await snapshot(a.db))
      expect(await saveOpenedRepo(b.db, folder('clone'), identity)).toBe(repoId)

      a.link.online = false
      b.link.online = false
      await editNote(a.db, n1, { body: 'check auth (A, offline)', severity: 'blocker' })
      await deleteNote(a.db, n2)
      const itemId = (await a.db.checklists.get(listId))!.items[0]!.id
      await setChecked(a.db, sessionId, itemId, true)
      await new Promise((r) => setTimeout(r, 5))
      await setNoteStatus(b.db, n1, 'resolved')
      const n3 = await addNote(b.db, { sessionId, path: 'src/sync/engine.ts', anchor, body: 'from B offline', severity: 'suggestion' })
      await b.db.fileViews.put({ sessionId, path: 'server/app.ts', contentHash: 'abc', viewed: true })
      await a.controller.sync()
      expect(a.controller.getSnapshot().pending).toBeGreaterThan(0)

      a.link.online = true
      b.link.online = true
      await a.controller.sync()
      await b.controller.sync()
      await a.controller.sync()

      const left = await snapshot(a.db)
      expect(left).toEqual(await snapshot(b.db))
      expect(left.notes.map((n) => n.id).sort()).toEqual([n1, n3].sort())
      expect(left.notes.find((n) => n.id === n1)).toMatchObject({ status: 'resolved' })
      expect(await checkedItems(b.db, sessionId)).toEqual(new Set([itemId]))
      expect(left.fileViews).toHaveLength(1)
      expect(await a.db.outbox.count()).toBe(0)
      expect(await b.db.outbox.count()).toBe(0)

      // Revoking B's token from A stops B, and B keeps its data.
      const tokens = await a.controller.listTokens()
      const bToken = tokens.find((t) => t.name === 'Device B')!
      await a.controller.revokeToken(bToken.id)
      await addNote(b.db, { sessionId, path: 'x', anchor, body: 'after revoke', severity: 'nit' })
      await b.controller.sync()
      expect(b.controller.getSnapshot().auth).toBe('expired')
      expect(await b.db.notes.count()).toBe(3)
    } finally {
      for (const d of [a, b]) {
        d.controller.dispose()
        await d.db.delete()
      }
    }
  })
})
