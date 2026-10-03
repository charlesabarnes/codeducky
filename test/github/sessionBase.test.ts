import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { SkelbertDb } from '../../src/db/db'
import { startOrResumeSession } from '../../src/db/sessions'

const opened: SkelbertDb[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.delete()))
})

describe('GitHub base on a session', () => {
  it('goes back to the local base when the session is resumed with a freshly resolved base', async () => {
    const db = new SkelbertDb('github-base')
    opened.push(db)
    const start = { repoId: 'r1', branch: 'feature', headSha: 'h1', baseSha: 'local-mb' }
    const id = await startOrResumeSession(db, start)
    await db.sessions.update(id, { baseSha: 'gh-mb', baseSource: 'github', githubBase: { branch: 'main', tipSha: 't' } })

    await startOrResumeSession(db, { ...start, headSha: 'h2' })
    const session = await db.sessions.get(id)
    expect(session).toMatchObject({ baseSha: 'local-mb', baseSource: 'local', headSha: 'h2' })
    expect(session).not.toHaveProperty('githubBase')
  })
})
