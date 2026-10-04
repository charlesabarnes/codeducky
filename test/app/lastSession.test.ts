import 'fake-indexeddb/auto'
import { matchRoutes } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { lastSessionPath } from '../../src/app/lastSession'
import { routes } from '../../src/app/routes'
import { CodeDuckyDb } from '../../src/db/db'
import type { Session } from '../../src/db/schema'

const dbs: CodeDuckyDb[] = []
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.delete()
})

const openDb = async (name: string) => {
  const db = new CodeDuckyDb(name)
  dbs.push(db)
  await db.repos.put({ id: 'r1', owner: 'acme', name: 'web', folderName: 'web', baseBranch: 'main', checklistIds: [], lastOpenedAt: 0 })
  return db
}

const session = (id: string, startedAt: number, repoId = 'r1'): Session => ({
  id,
  repoId,
  branch: id,
  headSha: 'h',
  baseSha: 'b',
  baseSource: 'local',
  startedAt,
  status: 'active',
})

describe('/last', () => {
  it('is an app route, ahead of the github.com-shaped pull request route', () => {
    expect(matchRoutes(routes, '/last')?.at(-1)?.route.id).toBe('last')
  })

  it('goes to the session opened last on this device', async () => {
    const db = await openDb('last-remembered')
    await db.sessions.bulkPut([session('older', 1), session('newer', 2)])
    expect(await lastSessionPath(db, 'older')).toBe('/sessions/older')
  })

  it('falls back to the newest session when the remembered one is gone or there is none', async () => {
    const db = await openDb('last-fallback')
    await db.sessions.bulkPut([session('a', 1), session('b', 3), session('c', 2)])
    expect(await lastSessionPath(db, 'deleted')).toBe('/sessions/b')
    expect(await lastSessionPath(db, null)).toBe('/sessions/b')
  })

  it('skips sessions whose repo is gone', async () => {
    const db = await openDb('last-orphan')
    await db.sessions.bulkPut([session('kept', 1), session('orphan', 5, 'deleted-repo')])
    expect(await lastSessionPath(db, 'orphan')).toBe('/sessions/kept')
    expect(await lastSessionPath(db, null)).toBe('/sessions/kept')
  })

  it('goes to the repos page without any session', async () => {
    expect(await lastSessionPath(await openDb('last-empty'), null)).toBe('/')
  })

  it('encodes the session id into one path segment', async () => {
    const db = await openDb('last-encode')
    await db.sessions.put(session('a/b', 1))
    expect(await lastSessionPath(db, 'a/b')).toBe('/sessions/a%2Fb')
  })
})
