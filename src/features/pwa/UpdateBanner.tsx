import { RefreshCw, X } from 'lucide-react'
import { useState } from 'react'
import { updates, useUpdates } from '../../update/updates'
import './pwa.css'

/** Offers a waiting version, or explains that the server needs a newer one while it loads. */
export function UpdateBanner() {
  const { available, required, updating } = useUpdates()
  const [dismissed, setDismissed] = useState(false)

  if (required !== null) {
    return (
      <div className="app-banner required" role="alert">
        <RefreshCw size={13} aria-hidden className={updating ? 'pulse' : undefined} />
        <span>
          <strong>update required.</strong>{' '}
          {updating
            ? 'The server needs a newer Code Ducky; loading it now.'
            : 'The server needs a newer Code Ducky than this one. Reload to update; your local data stays.'}
        </span>
        <span className="spacer" />
        {!updating && (
          <button type="button" onClick={() => void updates.apply()}>
            reload
          </button>
        )}
      </div>
    )
  }

  if (!available || dismissed) return null
  return (
    <div className="app-banner" role="status">
      <RefreshCw size={13} aria-hidden />
      <span>
        <strong>new version available.</strong> Reload to use it; your local data stays.
      </span>
      <span className="spacer" />
      <button type="button" disabled={updating} onClick={() => void updates.apply()}>
        {updating ? 'reloading…' : 'reload'}
      </button>
      <button type="button" className="link" aria-label="Later" title="Later" onClick={() => setDismissed(true)}>
        <X size={13} aria-hidden />
      </button>
    </div>
  )
}
