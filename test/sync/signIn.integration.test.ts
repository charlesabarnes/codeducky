import 'fake-indexeddb/auto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CodeDuckyDb } from '../../src/db/db'
import { addNote } from '../../src/db/notes'
import { SyncController } from '../../src/sync/controller'
import { fakeGitHubRoundTrip, fetchSend } from '../support/fakeSignIn'
import { ADMIN_PASSPHRASE, startServer } from '../support/realServer'

let base = ''
let stop = () => {}

beforeAll(async () => {
  ;({ base, stop } = await startServer())
})

afterAll(() => stop())

const anchor = { line: 1, side: 'new' as const, text: 'x', before: [], after: [] }

/** A tab: the controller with its own sessionStorage, and the GitHub round-trip it starts done over HTTP. */
function browserTab(db: CodeDuckyDb) {
  const stored = new Map<string, string>()
  const visited: string[] = []
  const controller = new SyncController(db, {
    baseUrl: base,
    listenToBrowser: false,
    debounceMs: 60_000,
    intervalMs: 3_600_000,
    navigate: (url) => void visited.push(url),
    sessionStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => void stored.set(key, value),
      removeItem: (key) => void stored.delete(key),
    },
  })
  const signIn = async (login: string) => {
    await controller.beginGitHubSignIn('Laptop')
    const challenge = new URL(visited.at(-1)!).searchParams.get('challenge')!
    const fragment = await fakeGitHubRoundTrip(fetchSend, base, login, challenge)
    return controller.completeSignIn(fragment.get('handoff')!)
  }
  return { controller, signIn }
}

describe('PWA sign-in against the real server', () => {
  it('signs in with GitHub, reads the session, and asks before switching accounts', async () => {
    const db = new CodeDuckyDb('int-signin')
    const tab = browserTab(db)
    try {
      await addNote(db, { sessionId: 's', path: 'a.ts', anchor, body: 'before sign-in', severity: 'nit' })
      expect(await tab.signIn('pwa-alice')).toBe('ok')
      await tab.controller.refreshSession()
      expect(tab.controller.getSnapshot()).toMatchObject({ auth: 'signedIn', user: { login: 'pwa-alice', role: 'user' }, usage: { records: 1 } })
      expect(tab.controller.getSnapshot().quota?.records).toBeGreaterThan(0)

      await tab.controller.signOut()
      expect(await tab.controller.adminSignIn('wrong', 'Laptop')).toBe('invalid')
      expect(await tab.controller.adminSignIn(ADMIN_PASSPHRASE, 'Laptop')).toBe('needsSwitch')
      await tab.controller.cancelSwitch()
      expect(await db.notes.count()).toBe(1)

      expect(await tab.signIn('pwa-bob')).toBe('needsSwitch')
      await tab.controller.confirmSwitch()
      expect(await db.notes.count()).toBe(0)
      await tab.controller.sync()
      await tab.controller.refreshSession()
      expect(tab.controller.getSnapshot()).toMatchObject({ user: { login: 'pwa-bob' }, usage: { records: 0 } })
    } finally {
      tab.controller.dispose()
      await db.delete()
    }
  })

  it('refuses a hand-off exchanged without the verifier this tab kept', async () => {
    const db = new CodeDuckyDb('int-verifier')
    const tab = browserTab(db)
    try {
      await tab.controller.beginGitHubSignIn('Laptop')
      const fragment = await fakeGitHubRoundTrip(fetchSend, base, 'pwa-carol', 'A'.repeat(43))
      expect(await tab.controller.completeSignIn(fragment.get('handoff')!)).toBe('invalid')
    } finally {
      tab.controller.dispose()
      await db.delete()
    }
  })
})
