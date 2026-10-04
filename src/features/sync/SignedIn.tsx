import { Database, Laptop, LogOut, RefreshCw, Trash2, UserX } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { syncController, useSyncState } from '../../sync/client'
import { DEFAULT_RETURN_TO, type Usage } from '../../sync/controller'
import type { SessionUser } from '../../sync/meta'
import { syncSummary } from '../../sync/summary'
import { signOutKeepingData, signOutRemovingData } from './accountActions'
import { Avatar } from './Avatar'
import { SYNC_ICONS } from './syncIcons'
import { usageLine, usageShare } from './usage'

export function SignedIn() {
  const state = useSyncState()
  const summary = syncSummary(state)
  const Icon = SYNC_ICONS[summary.tone]
  const { user } = state
  return (
    <>
      <div className="row sync-status">
        {user && (
          <span className="status-item account-name">
            <Avatar user={user} />
            <strong>@{user.login}</strong>
            {user.role === 'admin' && <span className="badge admin-badge">admin</span>}
          </span>
        )}
        <span className="status-item">
          <Laptop size={13} aria-hidden className="muted" />
          {state.deviceName}
        </span>
        <span className={`status-item sync-tone ${summary.tone}`}>
          <Icon size={13} aria-hidden />
          {summary.label.toLowerCase()}
        </span>
        {summary.detail && <span className="muted">· {summary.detail}</span>}
        <span className="spacer" />
        <button type="button" className="secondary" onClick={() => void syncController.sync()} disabled={state.status === 'syncing'}>
          <RefreshCw size={13} aria-hidden />
          sync now
        </button>
      </div>
      {state.usage && state.quota && <UsageMeter usage={state.usage} quota={state.quota} />}
      <div className="row sign-out-actions">
        <button type="button" className="secondary" onClick={signOutKeepingData}>
          <LogOut size={13} aria-hidden />
          sign out
        </button>
        <button type="button" className="secondary danger-text" onClick={() => void signOutRemovingData()}>
          <Trash2 size={13} aria-hidden />
          sign out and remove data from this browser
        </button>
      </div>
      {user && user.role !== 'admin' && <DeleteAccount user={user} />}
    </>
  )
}

function UsageMeter({ usage, quota }: { usage: Usage; quota: Usage }) {
  const share = usageShare(usage, quota)
  return (
    <div className="usage">
      <Database size={13} aria-hidden className="muted" />
      <span className="usage-meter" role="meter" aria-label="Storage used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
        <span className={share >= 0.9 ? 'full' : undefined} style={{ width: `${Math.max(share * 100, 1)}%` }} />
      </span>
      <span>{usageLine(usage, quota)}</span>
    </div>
  )
}

function DeleteAccount({ user }: { user: SessionUser }) {
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await syncController.deleteAccount(confirm)
      window.location.assign(DEFAULT_RETURN_TO)
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <details className="sub-section delete-account">
      <summary>
        <UserX size={13} aria-hidden />
        delete my account
      </summary>
      <form className="stack" onSubmit={submit}>
        <p>
          Deletes <strong>@{user.login}</strong> and all of its review data on the server, signs out every device and revokes
          its tokens and connected apps. This browser's copy is removed too. It cannot be undone.
        </p>
        <label className="field">
          <span>type {user.login} to confirm</span>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <div className="row">
          <button type="submit" className="danger-button" disabled={busy || confirm !== user.login}>
            <UserX size={13} aria-hidden />
            {busy ? 'deleting…' : 'delete my account'}
          </button>
          {error && <span className="error">{error}</span>}
        </div>
      </form>
    </details>
  )
}
