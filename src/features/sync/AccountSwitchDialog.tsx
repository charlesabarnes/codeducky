import { ArrowLeftRight, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { syncController, useSyncState } from '../../sync/client'
import type { SwitchRequest } from '../../sync/controller'
import { Avatar } from './Avatar'
import './sync.css'

/** Shown when someone signs in to a different account than the one this browser's data belongs to. */
export function AccountSwitchDialog() {
  const { switchRequest } = useSyncState()
  return switchRequest ? <SwitchDialog request={switchRequest} /> : null
}

function SwitchDialog({ request }: { request: SwitchRequest }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { from, to, unsent } = request

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await syncController.confirmSwitch()
      window.location.replace(request.returnTo)
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <dialog
      ref={dialog}
      className="modal switch-dialog"
      aria-labelledby="switch-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) void syncController.cancelSwitch()
      }}
    >
      <header className="modal-bar">
        <ArrowLeftRight size={14} aria-hidden />
        <h2 id="switch-title">switch account</h2>
        <span className="spacer" />
        <button type="button" className="link" disabled={busy} onClick={() => void syncController.cancelSwitch()}>
          <span className="key">esc</span> cancel
        </button>
      </header>
      <div className="modal-body stack">
        <div className="switch-accounts">
          <span className="switch-account">
            <span className="muted">this browser</span>
            <strong>@{from.login}</strong>
          </span>
          <ArrowLeftRight size={14} aria-hidden className="muted" />
          <span className="switch-account">
            <span className="muted">signing in</span>
            <strong>
              <Avatar user={to} /> @{to.login}
            </strong>
          </span>
        </div>
        <p>
          This browser holds review data from <strong>@{from.login}</strong>
          {unsent > 0 && (
            <>
              {' '}
              (<span className="error">{unsent} {unsent === 1 ? 'change' : 'changes'} not uploaded</span>)
            </>
          )}
          . Signing in as <strong>@{to.login}</strong> removes it from this browser, along with cached repo content and the
          GitHub token. @{from.login}'s synced data stays on the server.
        </p>
        {error && <p className="error">Could not remove the data: {error}</p>}
      </div>
      <footer className="modal-foot">
        <p>Appearance and keyboard settings stay.</p>
        <button type="button" className="secondary" disabled={busy} onClick={() => void syncController.cancelSwitch()}>
          cancel
        </button>
        <button type="button" className="danger-button" disabled={busy} onClick={() => void confirm()}>
          <Trash2 size={13} aria-hidden />
          {busy ? 'removing…' : 'remove and continue'}
        </button>
      </footer>
    </dialog>
  )
}
