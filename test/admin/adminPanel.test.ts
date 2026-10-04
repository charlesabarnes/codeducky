import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { adminApi, parseQuotaDraft, quotaDraft, statsLine, tokenLine, type AdminUser } from '../../src/features/admin/adminApi'
import { UsersTable, type UserActions } from '../../src/features/admin/UsersTable'

const NOW = Date.parse('2026-10-04T12:00:00Z')
const MB = 1024 * 1024

const account = (overrides: Partial<AdminUser>): AdminUser => ({
  id: 'u1',
  login: 'alice',
  name: 'Alice',
  avatarUrl: null,
  role: 'user',
  status: 'active',
  createdAt: NOW - 3 * 86_400_000,
  lastLoginAt: NOW - 3_600_000,
  lastSeenAt: NOW - 3_600_000,
  usage: { records: 3100, bytes: 1.5 * MB },
  quota: { records: 20_000, bytes: 50 * MB },
  override: { records: null, bytes: null },
  tokens: { session: 2, api: 1, oauth: 0 },
  grants: 1,
  channelSessions: 1,
  ...overrides,
})

const noActions: UserActions = {
  disable: async () => {},
  enable: async () => {},
  remove: async () => {},
  setQuota: async () => {},
}

const render = (users: AdminUser[]) => renderToStaticMarkup(createElement(UsersTable, { users, actions: noActions, now: NOW }))

describe('admin users table', () => {
  it('shows each account with usage, access and status', () => {
    const html = render([account({})])
    expect(html).toContain('@alice')
    expect(html).toContain('1.5 MB')
    expect(html).toContain('50 MB')
    expect(html).toContain('3,100 / 20,000 records')
    expect(html).toContain('2 devices · 1 API')
    expect(html).toContain('1 app · 1 live')
    expect(html).toContain('joined 3d ago · seen 1h ago')
    expect(html).toContain('status-active')
  })

  it('offers disable to active accounts and enable to disabled ones, and nothing on the admin row', () => {
    const active = render([account({})])
    expect(active).toContain('disable')
    expect(active).not.toContain('>enable')
    const disabled = render([account({ status: 'disabled' })])
    expect(disabled).toContain('enable')
    expect(disabled).toContain('disabled-account')
    const admin = render([account({ id: 'admin', login: 'admin', name: null, role: 'admin' })])
    expect(admin).toContain('admin-badge')
    expect(admin).not.toContain('delete')
    expect(admin).not.toContain('quota')
  })

  it('marks a custom quota', () => {
    expect(render([account({ override: { records: 500, bytes: null } })])).toContain('custom')
    expect(render([account({})])).not.toContain('custom')
  })
})

describe('admin helpers', () => {
  it('summarises the stats', () => {
    expect(statsLine({ users: 4, disabled: 1, signupsLastDay: 2, dbBytes: 1.2 * MB, signupsOpen: true, maxUsers: null })).toBe(
      '4 users · 1 disabled · 2 new in 24 h · signups open · db 1.2 MB',
    )
    expect(statsLine({ users: 1, disabled: 0, signupsLastDay: 0, dbBytes: 2048, signupsOpen: false, maxUsers: 10 })).toBe(
      '1 user · 0 new in 24 h · signups closed · db 2 KB',
    )
    expect(tokenLine({ session: 0, api: 0, oauth: 0 })).toBe('none')
    expect(tokenLine({ session: 1, api: 0, oauth: 3 })).toBe('1 device · 3 OAuth')
  })

  it('round-trips the quota editor, with blank meaning the default', () => {
    expect(quotaDraft({ records: null, bytes: null })).toEqual({ records: '', megabytes: '' })
    expect(quotaDraft({ records: 500, bytes: 50 * MB })).toEqual({ records: '500', megabytes: '50' })
    expect(parseQuotaDraft({ records: ' 500 ', megabytes: '2.5' })).toEqual({ records: 500, bytes: 2.5 * MB })
    expect(parseQuotaDraft({ records: '', megabytes: '' })).toEqual({ records: null, bytes: null })
    expect(parseQuotaDraft({ records: '0', megabytes: '' })).toEqual({ invalid: 'records' })
    expect(parseQuotaDraft({ records: '1.5', megabytes: '' })).toEqual({ invalid: 'records' })
    expect(parseQuotaDraft({ records: '', megabytes: '-1' })).toEqual({ invalid: 'megabytes' })
    expect(parseQuotaDraft({ records: '', megabytes: 'lots' })).toEqual({ invalid: 'megabytes' })
  })

  it('calls the admin endpoints', async () => {
    const request = vi.fn(async (method: string, path: string) => {
      if (path === '/api/admin/users') return { users: [account({})] }
      if (method === 'DELETE') return { ok: true }
      return { user: account({ status: 'disabled' }) }
    })
    const api = adminApi(request as never)
    expect(await api.users()).toHaveLength(1)
    await api.disable('u 1')
    await api.enable('u1')
    await api.setQuota('u1', { records: 10, bytes: null })
    await api.remove('u1')
    expect(request.mock.calls).toEqual([
      ['GET', '/api/admin/users'],
      ['POST', '/api/admin/users/u%201/disable'],
      ['POST', '/api/admin/users/u1/enable'],
      ['PATCH', '/api/admin/users/u1/quota', { records: 10, bytes: null }],
      ['DELETE', '/api/admin/users/u1'],
    ])
  })
})
