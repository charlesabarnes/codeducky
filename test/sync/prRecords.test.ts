import { describe, expect, it } from 'vitest'
import { validateChange } from '../../shared/sync'

const session = { repoId: 'gh:a/b', branch: 'f', headSha: 'h', baseSha: 'b', baseSource: 'github', startedAt: 1, status: 'active' }
const change = (kind: string, data: Record<string, unknown>, id = 'x') => ({ kind, id, changedAt: 1, deleted: false, data })

describe('pull request records', () => {
  it('accepts PR sessions and checks their fields', () => {
    expect(validateChange(change('sessions', { ...session, source: 'github-pr', pr: { owner: 'a', name: 'b', number: 3, title: 't' } }))).toBeNull()
    expect(validateChange(change('sessions', { ...session, status: 'archived', review: { state: 'APPROVED', at: 2, url: 'u' } }))).toBeNull()
    expect(validateChange(change('sessions', { ...session, source: 'svn' }))).toBe('sessions.source is invalid')
    expect(validateChange(change('sessions', { ...session, pr: { owner: 'a', name: 'b', number: '3' } }))).toBe('sessions.pr is invalid')
    expect(validateChange(change('sessions', { ...session, review: { state: 'LGTM', at: 2 } }))).toBe('sessions.review is invalid')
  })

  it('accepts the inbox snapshot and rejects malformed items', () => {
    const item = { repo: 'a/b', number: 1, title: 't', author: 'o', url: 'u', updatedAt: '2026-10-01T00:00:00Z', section: 'requested' }
    expect(validateChange(change('inbox', { fetchedAt: 1, items: [item] }, 'inbox'))).toBeNull()
    expect(validateChange(change('inbox', { fetchedAt: 1, items: [{ ...item, number: 'one' }] }, 'inbox'))).toBe('inbox.items is invalid')
    expect(validateChange(change('inbox', { items: [] }, 'inbox'))).toBe('inbox.fetchedAt is invalid')
  })
})
