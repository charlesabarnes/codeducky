import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { SkelbertDb } from '../../src/db/db'
import { appearanceOf, loadSettings, saveSettings } from '../../src/db/settings'

const opened: SkelbertDb[] = []
const openDb = (name: string) => {
  const db = new SkelbertDb(name)
  opened.push(db)
  return db
}

const DEFAULTS = { id: 'app', githubPat: '', theme: 'dark', palette: 'terminal', density: 'default', codeFont: 'plex' }

afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.delete()))
})

describe('settings', () => {
  it('returns defaults before anything is saved', async () => {
    expect(await loadSettings(openDb('defaults'))).toEqual(DEFAULTS)
  })

  it('persists across database connections', async () => {
    const first = openDb('persist')
    await saveSettings(first, { githubPat: ' ghp_x ' })
    first.close()
    expect(await loadSettings(openDb('persist'))).toEqual({ ...DEFAULTS, githubPat: 'ghp_x' })
  })

  it('saves the theme without touching the token', async () => {
    const db = openDb('theme')
    await saveSettings(db, { githubPat: 'ghp' })
    await saveSettings(db, { theme: 'light' })
    expect(await loadSettings(db)).toEqual({ ...DEFAULTS, githubPat: 'ghp', theme: 'light' })
  })

  it('saves palette, density and code font independently', async () => {
    const db = openDb('appearance')
    await saveSettings(db, { theme: 'system', palette: 'fjord' })
    await saveSettings(db, { density: 'compact' })
    await saveSettings(db, { codeFont: 'jetbrains' })
    expect(await loadSettings(db)).toEqual({ ...DEFAULTS, theme: 'system', palette: 'fjord', density: 'compact', codeFont: 'jetbrains' })
  })

  it('falls back to the defaults for unknown appearance values', async () => {
    const db = openDb('bad-appearance')
    await db.settings.put({ id: 'app', githubPat: '', theme: 'sepia', palette: 'neon', density: 'huge', codeFont: 'comic' } as never)
    expect(await loadSettings(db)).toEqual(DEFAULTS)
  })

  it('keeps settings saved before the palette, density and code font existed', async () => {
    const db = openDb('older')
    await db.settings.put({ id: 'app', githubPat: 'ghp', theme: 'light' })
    expect(await loadSettings(db)).toEqual({ ...DEFAULTS, githubPat: 'ghp', theme: 'light' })
  })

  it('ignores fields left over from the removed Claude pass', async () => {
    const db = openDb('leftover')
    await db.settings.put({ id: 'app', githubPat: 'ghp', anthropicKey: 'sk', claudeModel: 'm' } as never)
    expect(await loadSettings(db)).toEqual({ ...DEFAULTS, githubPat: 'ghp' })
  })
})

describe('appearanceOf', () => {
  it('reads cached strings and replaces missing or unknown ones', () => {
    expect(appearanceOf({ theme: 'light', palette: 'dusk', density: null, codeFont: 'wingdings' })).toEqual({
      theme: 'light',
      palette: 'dusk',
      density: 'default',
      codeFont: 'plex',
    })
  })
})
