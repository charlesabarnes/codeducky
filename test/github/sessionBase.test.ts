import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeDuckyDb } from '../../src/db/db'
import { startOrResumeSession } from '../../src/db/sessions'
import { GitHubError } from '../../src/github/errors'

const opened: CodeDuckyDb[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.delete()))
})

const start = { repoId: 'r1', branch: 'feature', headSha: 'h1', baseSha: 'local-mb' }

async function githubSession() {
  const db = new CodeDuckyDb(`github-base-${opened.length}`)
  opened.push(db)
  const id = await startOrResumeSession(db, start)
  await db.sessions.update(id, {
    baseSha: 'gh-mb',
    baseSource: 'github',
    githubBase: { branch: 'main', tipSha: 't1', pushedSha: 'p1' },
  })
  return { db, id }
}

describe('resuming a session on a GitHub base', () => {
  it('keeps the GitHub base and recomputes the merge base', async () => {
    const { db, id } = await githubSession()
    const resolve = vi.fn(async () => ({ headSha: 'h2', baseSha: 'gh-mb2', githubBase: { branch: 'main', tipSha: 't2' } }))

    expect(await startOrResumeSession(db, { ...start, headSha: 'h2' }, resolve)).toBe(id)
    expect(resolve).toHaveBeenCalledOnce()
    const session = await db.sessions.get(id)
    expect(session).toMatchObject({ headSha: 'h2', baseSha: 'gh-mb2', baseSource: 'github', githubBase: { branch: 'main', tipSha: 't2' } })
    expect(session?.githubBase).not.toHaveProperty('pushedSha')
    expect(session).not.toHaveProperty('baseNotice')
  })

  it('falls back to the local base with a notice when GitHub fails', async () => {
    const { db, id } = await githubSession()
    const resolve = vi.fn(async () => {
      throw new GitHubError('network', 0, 'Could not reach GitHub: offline')
    })

    await startOrResumeSession(db, { ...start, headSha: 'h2' }, resolve)
    const session = await db.sessions.get(id)
    expect(session).toMatchObject({ headSha: 'h2', baseSha: 'local-mb', baseSource: 'local' })
    expect(session).not.toHaveProperty('githubBase')
    expect(session?.baseNotice).toMatch(/uses your local base.*Could not reach GitHub: offline/)
  })

  it('falls back when there is no GitHub connection to resolve with', async () => {
    const { db, id } = await githubSession()
    await startOrResumeSession(db, start)
    expect(await db.sessions.get(id)).toMatchObject({ baseSource: 'local', baseSha: 'local-mb', baseNotice: expect.any(String) })
  })

  it('leaves GitHub alone for a local session and clears an old notice', async () => {
    const { db, id } = await githubSession()
    await startOrResumeSession(db, start)
    const resolve = vi.fn()
    await startOrResumeSession(db, { ...start, headSha: 'h3' }, resolve)
    expect(resolve).not.toHaveBeenCalled()
    const session = await db.sessions.get(id)
    expect(session).toMatchObject({ headSha: 'h3', baseSource: 'local' })
    expect(session).not.toHaveProperty('baseNotice')
  })
})
