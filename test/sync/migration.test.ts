import 'fake-indexeddb/auto'
import { Dexie } from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { SkelbertDb } from '../../src/db/db'

const names: string[] = []
afterEach(async () => {
  await Promise.all(names.splice(0).map((name) => Dexie.delete(name)))
})

/** The schema as phases 1-6 shipped it: numeric auto-increment ids and the folder handle on the repo. */
function legacyDb(name: string) {
  names.push(name)
  const db = new Dexie(name)
  db.version(1).stores({
    repos: '++id, [owner+name], lastOpenedAt',
    sessions: '++id, repoId, [repoId+branch], startedAt, status',
    fileViews: '[sessionId+path], sessionId',
    notes: '++id, sessionId, [sessionId+path], status',
    checklists: '++id, scope',
    checklistState: '[sessionId+itemId], sessionId',
    settings: 'id',
  })
  db.version(2).upgrade(() => undefined)
  return db
}

const handle = (name: string) => ({ kind: 'directory', name })
const anchor = { line: 1, side: 'new', text: 'x', before: [], after: [] }

async function seed(db: Dexie) {
  const t = db.table.bind(db)
  const tsundoku = await t('repos').add({ dirHandle: handle('tsundoku'), owner: 'charlesabarnes', name: 'Tsundoku', folderName: 'tsundoku', baseBranch: 'main', checklistIds: [], lastOpenedAt: 200 })
  const scratch = await t('repos').add({ dirHandle: handle('scratch'), owner: '', name: 'scratch', folderName: 'scratch', baseBranch: 'main', checklistIds: [], lastOpenedAt: 100 })
  const old = await t('sessions').add({ repoId: tsundoku, branch: 'feat', headSha: 'h1', baseSha: 'b', baseSource: 'local', startedAt: 1, status: 'archived' })
  const current = await t('sessions').add({ repoId: tsundoku, branch: 'feat', headSha: 'h2', baseSha: 'b', baseSource: 'local', startedAt: 2, status: 'active' })
  const other = await t('sessions').add({ repoId: scratch, branch: 'main', headSha: 'h', baseSha: 'b', baseSource: 'local', startedAt: 3, status: 'active' })
  const original = await t('notes').add({ sessionId: old, path: 'a.ts', anchor, body: 'first', severity: 'issue', status: 'open', source: 'me', createdAt: 1, updatedAt: 1 })
  await t('notes').add({ sessionId: current, path: 'a.ts', anchor, body: 'first', severity: 'issue', status: 'open', source: 'me', carriedFrom: original, createdAt: 1, updatedAt: 2, github: { reviewId: 99, commentId: 7 } })
  await t('notes').add({ sessionId: other, path: 'b.ts', anchor, body: 'gone', severity: 'nit', status: 'open', source: 'claude', carriedFrom: 999, createdAt: 3, updatedAt: 3 })
  const global = await t('checklists').add({ scope: 'global', title: 'Global', items: [{ id: 'i1', text: 'tests' }] })
  const perRepo = await t('checklists').add({ scope: tsundoku, title: 'Tsundoku', items: [{ id: 'i2', text: 'sync' }] })
  await t('repos').update(tsundoku, { checklistIds: [perRepo, 12345] })
  await t('checklistState').bulkAdd([
    { sessionId: current, itemId: 'i1', checked: true },
    { sessionId: other, itemId: 'i2', checked: false },
  ])
  await t('fileViews').bulkAdd([
    { sessionId: current, path: 'a.ts', contentHash: 'c1', viewed: true },
    { sessionId: old, path: 'a.ts', contentHash: 'c0', viewed: true },
  ])
  await t('settings').put({ id: 'app', githubPat: 'ghp', anthropicKey: 'sk', claudeModel: 'm' })
  return { global, perRepo }
}

describe('migration to string ids', () => {
  it('rewrites ids and every reference, and moves folder handles to a local table', async () => {
    const legacy = legacyDb('migrate-full')
    await seed(legacy)
    legacy.close()

    const db = new SkelbertDb('migrate-full')
    await db.open()
    expect(db.verno).toBe(7)
    expect(db.tables.map((t) => t.name).sort()).toEqual(
      ['checklistState', 'checklists', 'fileViews', 'githubBlobs', 'inbox', 'notes', 'outbox', 'rejected', 'repoHandles', 'repos', 'reviewSnapshots', 'sessions', 'settings', 'syncMeta'].sort(),
    )

    const repos = await db.repos.orderBy('lastOpenedAt').reverse().toArray()
    expect(repos.map((r) => r.id)).toEqual(['gh:charlesabarnes/tsundoku', expect.stringMatching(/^[0-9a-f-]{36}$/)])
    for (const repo of repos) {
      expect(repo).not.toHaveProperty('dirHandle')
      expect(repo.changedAt).toBeGreaterThan(0)
    }
    const [tsundoku, scratch] = repos as [(typeof repos)[0], (typeof repos)[0]]
    expect(await db.repoHandles.get(tsundoku.id!)).toMatchObject({ dirHandle: handle('tsundoku') })
    expect(await db.repoHandles.get(scratch.id!)).toMatchObject({ dirHandle: handle('scratch') })

    const sessions = await db.sessions.orderBy('startedAt').toArray()
    expect(sessions.map((s) => typeof s.id)).toEqual(['string', 'string', 'string'])
    expect(sessions.map((s) => s.repoId)).toEqual([tsundoku.id, tsundoku.id, scratch.id])
    const [old, current, other] = sessions as [(typeof sessions)[0], (typeof sessions)[0], (typeof sessions)[0]]
    expect(await db.sessions.where({ repoId: tsundoku.id, branch: 'feat' }).count()).toBe(2)

    const [original] = await db.notes.where({ sessionId: old.id }).toArray()
    const [carried] = await db.notes.where({ sessionId: current.id }).toArray()
    const [orphan] = await db.notes.where({ sessionId: other.id }).toArray()
    expect(carried).toMatchObject({ carriedFrom: original!.id, github: { reviewId: 99, commentId: 7 }, body: 'first' })
    expect(orphan!.carriedFrom).toBe('legacy-999')
    expect(await db.notes.where('[sessionId+path]').equals([current.id!, 'a.ts']).count()).toBe(1)

    const lists = await db.checklists.toArray()
    const perRepo = lists.find((l) => l.title === 'Tsundoku')!
    expect(lists.find((l) => l.title === 'Global')!.scope).toBe('global')
    expect(perRepo.scope).toBe(tsundoku.id)
    expect(tsundoku.checklistIds).toEqual([perRepo.id])
    expect(await db.checklists.where('scope').anyOf('global', tsundoku.id!).count()).toBe(2)

    expect(await db.checklistState.get([current.id!, 'i1'])).toMatchObject({ checked: true })
    expect(await db.checklistState.where({ sessionId: other.id }).count()).toBe(1)
    expect(await db.fileViews.get([current.id!, 'a.ts'])).toMatchObject({ contentHash: 'c1' })
    expect(await db.fileViews.where({ sessionId: old.id }).count()).toBe(1)

    expect(await db.settings.get('app')).toEqual({ id: 'app', githubPat: 'ghp' })
    expect(await db.outbox.count()).toBe(0)
    db.close()
  })

  it('upgrades a database from v1, applying the v2 note fix-ups first', async () => {
    names.push('migrate-v1')
    const v1 = new Dexie('migrate-v1')
    v1.version(1).stores({
      repos: '++id, [owner+name], lastOpenedAt',
      sessions: '++id, repoId, [repoId+branch], startedAt, status',
      fileViews: '[sessionId+path], sessionId',
      notes: '++id, sessionId, [sessionId+path], status',
      checklists: '++id, scope',
      checklistState: '[sessionId+itemId], sessionId',
      settings: 'id',
    })
    const sessionId = await v1.table('sessions').add({ repoId: 1, branch: 'b', headSha: 'h', baseSha: 'b', baseSource: 'local', startedAt: 1, status: 'active' })
    await v1.table('notes').add({ sessionId, path: 'a', anchor, body: 'x', severity: 'warning', status: 'open', source: 'me' })
    v1.close()

    const db = new SkelbertDb('migrate-v1')
    const [note] = await db.notes.toArray()
    const [session] = await db.sessions.toArray()
    expect(note).toMatchObject({ severity: 'issue', sessionId: session!.id })
    expect(note!.updatedAt).toBe(note!.createdAt)
    expect(session!.repoId).toBe('legacy-1')
    db.close()
  })

  it('creates the current schema directly on a fresh install', async () => {
    names.push('migrate-fresh')
    const db = new SkelbertDb('migrate-fresh')
    await db.open()
    expect(db.verno).toBe(7)
    expect(await db.repos.count()).toBe(0)
    db.close()
  })

  it('keeps the owner/name id for the most recently opened of two clones', async () => {
    const legacy = legacyDb('migrate-clones')
    await legacy.table('repos').bulkAdd([
      { dirHandle: handle('a'), owner: 'o', name: 'r', folderName: 'a', baseBranch: 'main', checklistIds: [], lastOpenedAt: 1 },
      { dirHandle: handle('b'), owner: 'o', name: 'r', folderName: 'b', baseBranch: 'main', checklistIds: [], lastOpenedAt: 2 },
    ])
    legacy.close()
    const db = new SkelbertDb('migrate-clones')
    const repos = await db.repos.toArray()
    expect(repos.find((r) => r.folderName === 'b')!.id).toBe('gh:o/r')
    expect(repos.find((r) => r.folderName === 'a')!.id).not.toBe('gh:o/r')
    db.close()
  })
})

/** The schema as v2 (phases 7-10) shipped it, with Claude-pass settings and repo instructions. */
function v4Db(name: string) {
  names.push(name)
  const db = new Dexie(name)
  db.version(4).stores({
    repos: 'id, [owner+name], lastOpenedAt',
    repoHandles: 'repoId',
    sessions: 'id, repoId, [repoId+branch], startedAt, status',
    fileViews: '[sessionId+path], sessionId',
    notes: 'id, sessionId, [sessionId+path], status',
    checklists: 'id, scope',
    checklistState: '[sessionId+itemId], sessionId',
    settings: 'id',
    outbox: 'key, changedAt',
    rejected: 'key, at',
    syncMeta: 'key',
  })
  return db
}

describe('migration away from the in-app Claude pass', () => {
  it('drops the Anthropic settings, renames repo instructions and queues them for sync', async () => {
    const old = v4Db('migrate-v5')
    const repo = { owner: 'o', name: 'r', folderName: 'r', baseBranch: 'main', checklistIds: [], lastOpenedAt: 1 }
    await old.table('repos').bulkAdd([
      { ...repo, id: 'gh:o/r', changedAt: 10, claudeInstructions: '  skip generated code ' },
      { ...repo, id: 'gh:o/empty', name: 'empty', changedAt: 10, claudeInstructions: '' },
      { ...repo, id: 'gh:o/plain', name: 'plain', changedAt: 10 },
    ])
    await old.table('notes').add({ id: 'n1', sessionId: 's', path: 'a', anchor, body: 'old', severity: 'nit', status: 'suggested', source: 'claude', createdAt: 1, updatedAt: 1 })
    await old.table('settings').put({ id: 'app', githubPat: 'ghp', anthropicKey: 'sk-ant', claudeModel: 'claude-opus-5-5' })
    old.close()

    const db = new SkelbertDb('migrate-v5')
    await db.open()
    expect(db.verno).toBe(7)
    expect(await db.settings.get('app')).toEqual({ id: 'app', githubPat: 'ghp' })

    const renamed = (await db.repos.get('gh:o/r'))!
    expect(renamed.instructions).toBe('skip generated code')
    expect(renamed).not.toHaveProperty('claudeInstructions')
    expect(renamed.changedAt).toBeGreaterThan(10)
    expect(await db.repos.get('gh:o/empty')).not.toHaveProperty('claudeInstructions')
    expect((await db.repos.get('gh:o/plain'))!.changedAt).toBe(10)
    expect(await db.outbox.toArray()).toEqual([
      { key: 'repos:gh:o/r', kind: 'repos', id: 'gh:o/r', changedAt: renamed.changedAt, deleted: false },
    ])

    expect(await db.notes.get('n1')).toMatchObject({ source: 'claude', status: 'suggested' })
    db.close()
  })
})
