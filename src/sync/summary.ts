import type { SyncSnapshot } from './controller'

type Tone = 'ok' | 'busy' | 'warn' | 'error' | 'muted'

/** A short status line for the header and Settings. */
export function syncSummary(state: SyncSnapshot): { label: string; tone: Tone; detail: string } {
  const pending = state.pending > 0 ? ` · ${state.pending} to upload` : ''
  if (state.auth === 'loading') return { label: '…', tone: 'muted', detail: '' }
  if (state.auth === 'signedOut') return { label: 'Local only', tone: 'muted', detail: 'Not signed in; sign in with GitHub to sync' }
  if (state.auth === 'expired') return { label: 'Sign in again', tone: 'error', detail: 'The sign-in was revoked or expired. Sign in again with GitHub.' }
  if (state.rejected > 0) return { label: `${state.rejected} not synced`, tone: 'error', detail: 'The server refused some changes; see Settings' }
  if (state.status === 'offline') return { label: `Offline${pending}`, tone: 'warn', detail: 'Changes are kept and upload when you are back online' }
  if (state.status === 'unreachable') return { label: `Server unreachable${pending}`, tone: 'warn', detail: 'Changes are kept and upload when the server is back' }
  if (state.status === 'error') return { label: `Sync failed${pending}`, tone: 'error', detail: state.lastError ?? '' }
  if (state.status === 'syncing') return { label: 'Syncing…', tone: 'busy', detail: '' }
  if (state.pending > 0) return { label: `${state.pending} to upload`, tone: 'busy', detail: '' }
  const at = state.lastSyncedAt ? `Last synced ${new Date(state.lastSyncedAt).toLocaleTimeString()}` : ''
  return { label: 'Synced', tone: 'ok', detail: at }
}
