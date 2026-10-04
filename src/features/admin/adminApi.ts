import type { Usage } from '../../sync/controller'
import type { SessionUser } from '../../sync/meta'
import { formatBytes } from '../sync/usage'

/** One account as GET /api/admin/users reports it: profile, status and usage, never record contents. */
export interface AdminUser extends SessionUser {
  status: 'active' | 'disabled'
  createdAt: number
  lastLoginAt: number | null
  lastSeenAt: number | null
  usage: Usage
  quota: Usage
  /** The account's own limits; null where the server default applies. */
  override: { records: number | null; bytes: number | null }
  tokens: { session: number; api: number; oauth: number }
  grants: number
  channelSessions: number
}

export interface AdminStats {
  users: number
  disabled: number
  signupsLastDay: number
  dbBytes: number
  signupsOpen: boolean
  maxUsers: number | null
}

export type QuotaOverride = AdminUser['override']

/** An authenticated request to the sync server, as the sync controller makes it. */
export type AdminRequest = <T>(method: string, path: string, body?: unknown) => Promise<T>

const userPath = (id: string) => `/api/admin/users/${encodeURIComponent(id)}`

export function adminApi(request: AdminRequest) {
  return {
    users: () => request<{ users: AdminUser[] }>('GET', '/api/admin/users').then((r) => r.users),
    stats: () => request<AdminStats>('GET', '/api/admin/stats'),
    disable: (id: string) => request<{ user: AdminUser }>('POST', `${userPath(id)}/disable`).then((r) => r.user),
    enable: (id: string) => request<{ user: AdminUser }>('POST', `${userPath(id)}/enable`).then((r) => r.user),
    remove: (id: string) => request<{ ok: true }>('DELETE', userPath(id)),
    setQuota: (id: string, override: QuotaOverride) =>
      request<{ user: AdminUser }>('PATCH', `${userPath(id)}/quota`, override).then((r) => r.user),
  }
}

export type AdminApi = ReturnType<typeof adminApi>

const MB = 1024 * 1024

/** The quota editor's fields: a record count and megabytes, blank for the server default. */
export interface QuotaDraft {
  records: string
  megabytes: string
}

export function quotaDraft(override: QuotaOverride): QuotaDraft {
  return {
    records: override.records === null ? '' : String(override.records),
    megabytes: override.bytes === null ? '' : String(Math.round((override.bytes / MB) * 100) / 100),
  }
}

/** The override a draft asks for, or the field that is not a positive number. */
export function parseQuotaDraft(draft: QuotaDraft): QuotaOverride | { invalid: keyof QuotaDraft } {
  const records = draft.records.trim()
  const megabytes = draft.megabytes.trim()
  const count = Number(records)
  const size = Number(megabytes)
  if (records && !(Number.isSafeInteger(count) && count > 0)) return { invalid: 'records' }
  if (megabytes && !(Number.isFinite(size) && Math.round(size * MB) > 0)) return { invalid: 'megabytes' }
  return { records: records ? count : null, bytes: megabytes ? Math.round(size * MB) : null }
}

/** "4 users · 1 disabled · 2 new in 24 h · signups open · db 1.2 MB" */
export function statsLine(stats: AdminStats): string {
  const parts = [`${stats.users.toLocaleString('en-US')} ${stats.users === 1 ? 'user' : 'users'}`]
  if (stats.disabled) parts.push(`${stats.disabled} disabled`)
  parts.push(`${stats.signupsLastDay} new in 24 h`)
  parts.push(stats.signupsOpen ? (stats.maxUsers === null ? 'signups open' : `signups open, cap ${stats.maxUsers}`) : 'signups closed')
  parts.push(`db ${formatBytes(stats.dbBytes)}`)
  return parts.join(' · ')
}

/** "1 device · 2 API · 1 OAuth", or "none". */
export function tokenLine({ session, api, oauth }: AdminUser['tokens']): string {
  const parts = [session && `${session} ${session === 1 ? 'device' : 'devices'}`, api && `${api} API`, oauth && `${oauth} OAuth`]
  return parts.filter(Boolean).join(' · ') || 'none'
}

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
