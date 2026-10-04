import { describe, expect, it } from 'bun:test'
import { openMemoryDatabase } from './db'
import { ADMIN_USER_ID, ensureAdmin, getUser, getUserByGitHubId, upsertGitHubUser } from './users/store'

describe('users', () => {
  it('creates the admin account once', () => {
    const db = openMemoryDatabase()
    ensureAdmin(db, 1)
    ensureAdmin(db, 2)
    expect(getUser(db, ADMIN_USER_ID)).toMatchObject({ login: 'admin', role: 'admin', status: 'active', githubId: null, createdAt: 1 })
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM users').get()!.n).toBe(1)
  })

  it('keys GitHub users by id and refreshes their profile on each sign-in', () => {
    const db = openMemoryDatabase()
    const first = upsertGitHubUser(db, { id: 42, login: 'alice', name: 'Alice', avatarUrl: null }, 10)
    expect(first).toMatchObject({ githubId: 42, login: 'alice', role: 'user', status: 'active', createdAt: 10, lastLoginAt: 10 })

    const renamed = upsertGitHubUser(db, { id: 42, login: 'alice-renamed', name: null, avatarUrl: 'https://avatars.githubusercontent.com/u/42' }, 20)
    expect(renamed).toMatchObject({ id: first.id, login: 'alice-renamed', name: null, createdAt: 10, lastLoginAt: 20 })
    expect(getUserByGitHubId(db, 42)?.avatarUrl).toBe('https://avatars.githubusercontent.com/u/42')

    const other = upsertGitHubUser(db, { id: 7, login: 'alice', name: null, avatarUrl: null }, 30)
    expect(other.id).not.toBe(first.id)
    expect(getUserByGitHubId(db, 99)).toBeNull()
  })
})
