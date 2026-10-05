import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { setChecked } from '../../src/db/checklists'
import { CodeDuckyDb } from '../../src/db/db'
import { markViewed } from '../../src/db/fileViews'
import { addNote, deleteNote } from '../../src/db/notes'
import { openPatchSession, PATCH_REPO_ID, patchSessions, removePatchSession } from '../../src/db/patchSessions'
import { startOrResumeSession } from '../../src/db/sessions'
import { openLaunchedFiles, openPatchFiles } from '../../src/features/patch/openPatch'
import { patchSource } from '../../src/features/patch/patchSource'
import { parsePatchSet } from '../../src/review/patchSet'
import { enqueueAll } from '../../src/sync/engine'

const opened: CodeDuckyDb[] = []
const open = (name: string) => {
  const db = new CodeDuckyDb(name)
  opened.push(db)
  return db
}
afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.delete()))
})

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -3,3 +3,3 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  ' const c = 4',
  'diff --git a/src/b.ts b/src/b.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/b.ts',
  '@@ -0,0 +1 @@',
  '+export const b = 3',
  '',
].join('\n')
const anchor = { line: 4, side: 'new' as const, text: 'const b = 3', before: ['const a = 1'], after: ['const c = 4'] }
const file = (name: string, text: string) => ({ name, size: text.length, text: async () => text })

describe('patch sessions', () => {
  it('opens a patch as a local-only session named after the file', async () => {
    const db = open('patch-open')
    const id = await openPatchSession(db, { name: 'fix.patch', text: PATCH })
    const session = await db.sessions.get(id)
    expect(id.startsWith('patch-')).toBe(true)
    expect(session).toMatchObject({ repoId: PATCH_REPO_ID, branch: 'fix.patch', source: 'patch', status: 'active' })
    expect(session!.headSha).toMatch(/^[0-9a-f]{40}$/)
    expect((await db.patches.get(id))?.text).toBe(PATCH)
    expect((await patchSessions(db)).map((s) => s.id)).toEqual([id])
  })

  it('reopens the active session of the same patch, keeping its notes', async () => {
    const db = open('patch-reopen')
    const first = await openPatchSession(db, { name: 'fix.patch', text: PATCH })
    await addNote(db, { sessionId: first, path: 'src/a.ts', anchor, body: 'why 3?', severity: 'issue' })
    expect(await openPatchSession(db, { name: 'fix (1).patch', text: PATCH })).toBe(first)
    expect((await db.sessions.get(first))?.branch).toBe('fix (1).patch')
    expect(await openPatchSession(db, { name: 'other.patch', text: PATCH.replace('const b = 3', 'const b = 5') })).not.toBe(first)
  })

  it('refuses a file with no changes in it', async () => {
    const db = open('patch-empty')
    await expect(openPatchSession(db, { name: 'notes.txt', text: 'hello' })).rejects.toThrow('no file changes')
    expect(await db.sessions.count()).toBe(0)
  })

  it('never queues the session, its notes, views or checklist ticks for sync, while other sessions still sync', async () => {
    const db = open('patch-local')
    const id = await openPatchSession(db, { name: 'fix.patch', text: PATCH })
    const noteId = await addNote(db, { sessionId: id, path: 'src/a.ts', anchor, body: 'local', severity: 'nit' })
    await markViewed(db, { sessionId: id, change: { path: 'src/a.ts', oldOid: 'o', newOid: 'n' }, viewed: true, head: 'h' })
    await setChecked(db, id, 'item', true)
    await deleteNote(db, noteId)
    expect(await db.outbox.count()).toBe(0)

    const synced = await startOrResumeSession(db, { repoId: 'gh:o/r', branch: 'feat', headSha: 'h', baseSha: 'b' })
    await db.outbox.clear()
    expect(await enqueueAll(db)).toBe(1)
    expect((await db.outbox.toArray()).map((entry) => entry.id)).toEqual([synced])
  })

  it('removes a patch session with its file and records', async () => {
    const db = open('patch-remove')
    const id = await openPatchSession(db, { name: 'fix.patch', text: PATCH })
    await addNote(db, { sessionId: id, path: 'src/a.ts', anchor, body: 'x', severity: 'nit' })
    await removePatchSession(db, id)
    expect(await db.sessions.count()).toBe(0)
    expect(await db.notes.count()).toBe(0)
    expect(await db.patches.count()).toBe(0)
    expect(await db.outbox.count()).toBe(0)
  })

  it('opens picked and launched files, and says why a launch failed', async () => {
    const db = open('patch-files')
    const id = await openPatchFiles(db, [file('a.diff', PATCH)])
    expect((await db.sessions.get(id!))?.branch).toBe('a.diff')
    const handle = { kind: 'file', getFile: async () => file('b.patch', PATCH.replace('3', '9')) } as unknown as FileSystemFileHandle
    const launched = await openLaunchedFiles(db, [handle])
    expect(launched.to).toMatch(/^\/sessions\/patch-/)
    const bad = { kind: 'file', getFile: async () => file('c.patch', 'nothing') } as unknown as FileSystemFileHandle
    expect(await openLaunchedFiles(db, [bad])).toEqual({ to: '/', patchError: expect.stringContaining('c.patch') })
  })
})

describe('patchSource', () => {
  const source = patchSource('s', parsePatchSet(PATCH), 'head')

  it('lists the files with content ids and counts', async () => {
    const { files } = await source.listFiles()
    expect(files.map(({ path, status }) => [path, status])).toEqual([
      ['src/a.ts', 'modified'],
      ['src/b.ts', 'added'],
    ])
    expect(files[0]!.oldOid).toMatch(/^[0-9a-f]{40}$/)
    expect(files[1]!.oldOid).toBeNull()
    expect((await source.analyze(files)).stats).toEqual({ 'src/a.ts': { additions: 1, deletions: 1 }, 'src/b.ts': { additions: 1, deletions: 0 } })
  })

  it('serves each side rebuilt from the hunks, lines at their real numbers', async () => {
    const { files } = await source.listFiles()
    const contents = await source.contents(files[0]!)
    expect(contents.new).toEqual({ kind: 'text', text: '\n\nconst a = 1\nconst b = 3\nconst c = 4\n', size: 38 })
    expect(contents.old?.kind === 'text' && contents.old.text.split('\n')[3]).toBe('const b = 2')
    expect(await source.ciHead()).toBe('head')
  })
})
