import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { SkelbertDb } from '../../src/db/db'
import { loadSettings, saveSettings } from '../../src/db/settings'

const opened: SkelbertDb[] = []
const openDb = (name: string) => {
  const db = new SkelbertDb(name)
  opened.push(db)
  return db
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.delete()))
})

describe('settings', () => {
  it('returns defaults before anything is saved', async () => {
    expect(await loadSettings(openDb('defaults'))).toEqual({ id: 'app', githubPat: '', theme: 'dark' })
  })

  it('persists across database connections', async () => {
    const first = openDb('persist')
    await saveSettings(first, { githubPat: ' ghp_x ' })
    first.close()
    expect(await loadSettings(openDb('persist'))).toEqual({ id: 'app', githubPat: 'ghp_x', theme: 'dark' })
  })

  it('saves the theme without touching the token', async () => {
    const db = openDb('theme')
    await saveSettings(db, { githubPat: 'ghp' })
    await saveSettings(db, { theme: 'light' })
    expect(await loadSettings(db)).toEqual({ id: 'app', githubPat: 'ghp', theme: 'light' })
  })

  it('falls back to dark for an unknown theme', async () => {
    const db = openDb('bad-theme')
    await db.settings.put({ id: 'app', githubPat: '', theme: 'sepia' } as never)
    expect((await loadSettings(db)).theme).toBe('dark')
  })

  it('ignores fields left over from the removed Claude pass', async () => {
    const db = openDb('leftover')
    await db.settings.put({ id: 'app', githubPat: 'ghp', anthropicKey: 'sk', claudeModel: 'm' } as never)
    expect(await loadSettings(db)).toEqual({ id: 'app', githubPat: 'ghp', theme: 'dark' })
  })
})
