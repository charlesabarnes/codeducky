import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { ACCOUNT_TABLES } from '../../src/db/accountData'
import { CodeDuckyDb } from '../../src/db/db'
import { addNote } from '../../src/db/notes'
import { loadSettings, saveSettings } from '../../src/db/settings'
import { PENDING_SIGN_IN_KEY, safeReturnTo, SyncController } from '../../src/sync/controller'
import { META_ACCOUNT, getMeta } from '../../src/sync/meta'
import { challengeOf } from '../../src/sync/pkce'
import { fakeBrowser, FakeSyncServer, signInWithGitHub } from '../support/fakeSyncServer'

const opened: { db: CodeDuckyDb; controller: SyncController }[] = []
afterEach(async () => {
  for (const { db, controller } of opened.splice(0)) {
    controller.dispose()
    await db.delete()
  }
})

function tab(name: string, server: FakeSyncServer, db = new CodeDuckyDb(name)) {
  const browser = fakeBrowser(server)
  const controller = new SyncController(db, { ...browser, listenToBrowser: false, debounceMs: 10_000, intervalMs: 3_600_000 })
  opened.push({ db, controller })
  return { db, controller, browser, signIn: (login: string) => signInWithGitHub(controller, browser, server, login, name) }
}

const anchor = { line: 1, side: 'new' as const, text: 'x', before: [], after: [] }
const note = (db: CodeDuckyDb, body: string) => addNote(db, { sessionId: 's', path: 'a.ts', anchor, body, severity: 'nit' })

describe('GitHub sign-in', () => {
  it('starts with an S256 challenge of a verifier kept in sessionStorage', async () => {
    const server = new FakeSyncServer()
    const a = tab('begin', server)
    await a.controller.beginGitHubSignIn('Laptop', '/inbox')
    const url = new URL(a.browser.visited[0]!, 'http://fake')
    expect(url.pathname).toBe('/api/auth/github/start')
    const pending = JSON.parse(a.browser.sessionStorage.getItem(PENDING_SIGN_IN_KEY)!)
    expect(pending).toMatchObject({ name: 'Laptop', returnTo: '/inbox' })
    expect(url.searchParams.get('challenge')).toBe(await challengeOf(pending.verifier))
    expect(a.controller.pendingReturnTo()).toBe('/inbox')
  })

  it('exchanges the hand-off, binds the account and uploads what the browser already had', async () => {
    const server = new FakeSyncServer()
    const a = tab('complete', server)
    await note(a.db, 'from before sign-in')
    expect(await a.signIn('alice')).toBe('ok')
    expect(a.browser.sessionStorage.getItem(PENDING_SIGN_IN_KEY)).toBeNull()
    expect(a.controller.getSnapshot()).toMatchObject({ auth: 'signedIn', deviceName: 'complete', user: { login: 'alice' } })
    expect(await getMeta(a.db, META_ACCOUNT)).toEqual({ id: 'user-alice', login: 'alice' })
    expect(server.live('notes', 'alice')).toHaveLength(1)
  })

  it('refuses a hand-off without this tab’s verifier, or with the wrong one', async () => {
    const server = new FakeSyncServer()
    const a = tab('verifier', server)
    expect(await a.controller.completeSignIn(server.handoff('alice', 'x'))).toBe('invalid')
    await a.controller.beginGitHubSignIn('A')
    expect(await a.controller.completeSignIn(server.handoff('alice', await challengeOf('another verifier')))).toBe('invalid')
    expect(a.controller.getSnapshot().auth).toBe('signedOut')
  })

  it('reports offline when the exchange cannot reach the server', async () => {
    const server = new FakeSyncServer()
    const a = tab('offline', server)
    await a.controller.beginGitHubSignIn('A')
    const challenge = new URL(a.browser.visited[0]!, 'http://fake').searchParams.get('challenge')!
    server.offline = true
    expect(await a.controller.completeSignIn(server.handoff('alice', challenge))).toBe('offline')
  })

  it('keeps the data when the same account signs in again', async () => {
    const server = new FakeSyncServer()
    const a = tab('same', server)
    await a.signIn('alice')
    await a.controller.signOut()
    await note(a.db, 'written while signed out')
    expect(await a.signIn('alice')).toBe('ok')
    expect(await a.db.notes.count()).toBe(1)
    expect(server.live('notes', 'alice')).toHaveLength(1)
  })

  it('signs in to the admin account with the passphrase', async () => {
    const server = new FakeSyncServer()
    const a = tab('admin', server)
    expect(await a.controller.adminSignIn('wrong', 'A')).toBe('invalid')
    expect(await a.controller.adminSignIn('pass', 'A')).toBe('ok')
    expect(a.controller.getSnapshot().user).toMatchObject({ id: 'admin', role: 'admin' })
  })
})

describe('switching accounts', () => {
  async function aliceSignedOut() {
    const server = new FakeSyncServer()
    const a = tab('switch', server)
    await saveSettings(a.db, { githubPat: 'ghp_alice', palette: 'dusk' })
    await a.signIn('alice')
    await note(a.db, 'alice synced')
    await a.controller.sync()
    await a.controller.signOut()
    await note(a.db, 'alice unsent')
    return { server, a }
  }

  it('asks before another account signs in, and cancelling keeps the data and revokes the new token', async () => {
    const { server, a } = await aliceSignedOut()
    expect(await a.signIn('bob')).toBe('needsSwitch')
    expect(a.controller.getSnapshot()).toMatchObject({
      auth: 'signedOut',
      switchRequest: { from: { login: 'alice' }, to: { login: 'bob' }, unsent: 1, returnTo: '/settings#sync' },
    })
    expect(server.sessionCount('bob')).toBe(1)

    await a.controller.cancelSwitch()
    expect(server.sessionCount('bob')).toBe(0)
    expect(a.controller.getSnapshot()).toMatchObject({ auth: 'signedOut', switchRequest: null })
    expect(await a.db.notes.count()).toBe(2)
    expect(await getMeta(a.db, META_ACCOUNT)).toMatchObject({ login: 'alice' })
    expect(server.live('notes', 'bob')).toHaveLength(0)
  })

  it('confirming wipes the browser, keeps appearance, and uploads nothing of alice’s to bob', async () => {
    const { server, a } = await aliceSignedOut()
    await a.signIn('bob')
    await a.controller.confirmSwitch()

    for (const name of ACCOUNT_TABLES.filter((name) => name !== 'syncMeta')) expect(await a.db.table(name).count(), name).toBe(0)
    expect(await loadSettings(a.db)).toMatchObject({ githubPat: '', palette: 'dusk' })
    expect(await getMeta(a.db, META_ACCOUNT)).toEqual({ id: 'user-bob', login: 'bob' })
    expect(a.controller.getSnapshot()).toMatchObject({ auth: 'signedIn', user: { login: 'bob' }, switchRequest: null })

    // What the page reload does: a fresh controller on the same database.
    a.controller.dispose()
    const reloaded = tab('switch', server, a.db)
    await reloaded.controller.start()
    await reloaded.controller.sync()
    expect(server.live('notes', 'bob')).toHaveLength(0)
    expect(server.live('notes', 'alice')).toHaveLength(1)
  })

  it('sign out and remove data empties the browser and forgets the account', async () => {
    const server = new FakeSyncServer()
    const a = tab('remove', server)
    await a.signIn('alice')
    await note(a.db, 'alice')
    await a.controller.signOutAndRemoveData()
    for (const name of ACCOUNT_TABLES) expect(await a.db.table(name).count(), name).toBe(0)
    expect(server.sessionCount('alice')).toBe(0)
    expect(await a.signIn('bob')).toBe('ok')
  })
})

describe('session', () => {
  it('refreshes the profile, usage and quota', async () => {
    const server = new FakeSyncServer()
    const a = tab('session', server)
    await a.signIn('alice')
    await note(a.db, 'counted')
    await a.controller.sync()
    await a.controller.refreshSession()
    expect(a.controller.getSnapshot()).toMatchObject({ user: { login: 'alice' }, usage: { records: 1 }, quota: server.quota })
  })

  it('expires when the server no longer accepts the token', async () => {
    const server = new FakeSyncServer()
    const a = tab('disabled', server)
    await a.signIn('alice')
    server.revokeAll()
    await a.controller.refreshSession()
    expect(a.controller.getSnapshot()).toMatchObject({ auth: 'expired', user: null })
    expect(await getMeta(a.db, META_ACCOUNT)).toMatchObject({ login: 'alice' })
  })

  it('deletes the account on the server and in this browser', async () => {
    const server = new FakeSyncServer()
    const a = tab('delete', server)
    await a.signIn('alice')
    await note(a.db, 'gone')
    await a.controller.sync()
    await expect(a.controller.deleteAccount('bob')).rejects.toThrow()
    await a.controller.deleteAccount('alice')
    expect(server.live('notes', 'alice')).toHaveLength(0)
    expect(await a.db.notes.count()).toBe(0)
    expect(a.controller.getSnapshot().auth).toBe('signedOut')
  })
})

describe('return paths', () => {
  it('only allows same-origin paths', () => {
    expect(safeReturnTo('/inbox')).toBe('/inbox')
    expect(safeReturnTo('/settings#sync')).toBe('/settings#sync')
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', '', null, 3]) expect(safeReturnTo(bad)).toBe('/settings#sync')
  })
})
