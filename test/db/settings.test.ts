import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { SkelbertDb } from '../../src/db/db'
import { DEFAULT_CLAUDE_MODEL, loadSettings, saveSettings } from '../../src/db/settings'

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
    const settings = await loadSettings(openDb('defaults'))
    expect(settings).toEqual({ id: 'app', githubPat: '', anthropicKey: '', claudeModel: DEFAULT_CLAUDE_MODEL })
  })

  it('persists across database connections', async () => {
    const first = openDb('persist')
    await saveSettings(first, { githubPat: ' ghp_x ', anthropicKey: 'sk-ant', claudeModel: '' })
    first.close()

    const reopened = await loadSettings(openDb('persist'))
    expect(reopened).toEqual({ id: 'app', githubPat: 'ghp_x', anthropicKey: 'sk-ant', claudeModel: DEFAULT_CLAUDE_MODEL })
  })
})
