import { Database, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { formatBytes, readStorageStatus, requestPersistence, type StorageStatus } from '../../pwa/storage'
import { Panel } from '../../ui/Panel'
import './pwa.css'

export function StoragePanel() {
  const [status, setStatus] = useState<StorageStatus | null>(null)
  const [refused, setRefused] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => readStorageStatus().then(setStatus), [])
  useEffect(() => {
    void load()
  }, [load])

  const request = async () => {
    setBusy(true)
    try {
      setRefused(!(await requestPersistence()))
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel icon={Database} title="storage" id="storage">
      <p>
        Repos, sessions and notes live in this browser. Persistent storage stops the browser from clearing them when the disk runs
        low; Code Ducky asks for it once you have opened a repo or installed the app.
      </p>
      {!status ? (
        <p className="muted">Checking storage…</p>
      ) : !status.supported ? (
        <p className="muted">This browser cannot keep storage persistent.</p>
      ) : (
        <>
          <dl className="pwa-facts">
            <dt>status</dt>
            <dd>
              {status.persisted ? (
                <span className="ok-text">persistent: the browser will not clear it on its own</span>
              ) : (
                <span className="warn-text">best effort: the browser may clear it under storage pressure</span>
              )}
            </dd>
            <dt>usage</dt>
            <dd>
              {status.usage === null ? (
                'unknown'
              ) : (
                <UsageLine usage={status.usage} quota={status.quota} />
              )}
            </dd>
          </dl>
          {!status.persisted && (
            <div className="row">
              <button type="button" onClick={request} disabled={busy}>
                <ShieldCheck size={13} aria-hidden />
                {busy ? 'asking…' : 'make storage persistent'}
              </button>
              {refused && (
                <span className="muted">
                  The browser declined. Chrome grants it to installed apps and sites you use often; try again after installing.
                </span>
              )}
            </div>
          )}
        </>
      )}
    </Panel>
  )
}

function UsageLine({ usage, quota }: { usage: number; quota: number | null }) {
  const share = quota ? Math.min(1, usage / quota) : null
  return (
    <span className="stack">
      <span>
        {formatBytes(usage)} used
        {quota ? ` of a ${formatBytes(quota)} quota` : ''}
      </span>
      {share !== null && (
        <span className="storage-meter" aria-hidden>
          <span style={{ width: `${Math.max(share * 100, 0.5)}%` }} />
        </span>
      )}
    </span>
  )
}
