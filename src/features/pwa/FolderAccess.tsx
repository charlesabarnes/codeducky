import { FolderLock, Unlock } from 'lucide-react'
import { useEffect, useState } from 'react'
import { supportsFileSystemAccess } from '../../fs/permission'
import { folderAccess, useFolderAccess } from '../../pwa/client'
import { restorable } from '../../pwa/folderAccess'
import { isInstalled } from '../../pwa/install'
import { Panel } from '../../ui/Panel'
import './pwa.css'

/** How long the browser keeps folder access, which depends on whether the app is installed. */
export function AccessDurationNote() {
  return isInstalled() ? (
    <>
      Installed, Code Ducky can keep folder access between launches: when Chrome asks, choose <strong>Allow on every visit</strong>.
    </>
  ) : (
    <>
      In a browser tab, access lasts for this session only, so the browser asks again after Code Ducky is closed. Install it as an
      app to keep access between launches.
    </>
  )
}

function useRefreshOnMount() {
  useEffect(() => {
    folderAccess.refresh().catch((error: unknown) => console.warn('Could not check folder access', error))
  }, [])
}

function useRestore() {
  const [busy, setBusy] = useState(false)
  const restore = async (repoIds?: string[]) => {
    setBusy(true)
    try {
      await folderAccess.restore(repoIds)
    } finally {
      setBusy(false)
    }
  }
  return { busy, restore }
}

/** On the repos page: one click to ask again for every folder that lost access since the last launch. */
export function FolderAccessNotice() {
  useRefreshOnMount()
  const { entries } = useFolderAccess()
  const { busy, restore } = useRestore()
  const pending = restorable(entries)
  if (pending.length === 0) return null
  const names = pending.map((entry) => entry.label).join(', ')
  return (
    <div className="access-notice" role="status">
      <FolderLock size={13} aria-hidden />
      <span>
        {pending.length === 1 ? `${names} needs` : `${pending.length} repos need`} folder access again
        {pending.length > 1 && <span className="muted"> ({names})</span>}.{' '}
        <span className="muted">
          <AccessDurationNote />
        </span>
      </span>
      <button type="button" onClick={() => void restore()} disabled={busy}>
        <Unlock size={13} aria-hidden />
        {busy ? 'asking…' : 'restore access'}
      </button>
    </div>
  )
}

const STATE_LABELS: Record<PermissionState, string> = {
  granted: 'allowed',
  prompt: 'needs access',
  denied: 'blocked',
}

export function FolderAccessPanel() {
  useRefreshOnMount()
  const { checked, entries } = useFolderAccess()
  const { busy, restore } = useRestore()
  const pending = restorable(entries)

  return (
    <Panel icon={FolderLock} title="folder access" id="folder-access">
      <p>
        Code Ducky reads your checkouts through folder handles the browser keeps for each repo. <AccessDurationNote />
      </p>
      {!supportsFileSystemAccess() ? (
        <p className="muted">This browser cannot open local folders.</p>
      ) : !checked ? (
        <p className="muted">Checking folder access…</p>
      ) : entries.length === 0 ? (
        <p className="muted">No repo folders opened in this browser yet.</p>
      ) : (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>repo</th>
                <th className="col-fixed">folder</th>
                <th className="col-fixed">access</th>
                <th className="col-fixed" />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.repoId}>
                  <td>{entry.label}</td>
                  <td className="muted">{entry.handle.name}</td>
                  <td className={`access-state ${entry.state}`}>{STATE_LABELS[entry.state]}</td>
                  <td>
                    {entry.state === 'prompt' && (
                      <button type="button" className="link accent" disabled={busy} onClick={() => void restore([entry.repoId])}>
                        restore
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {entries.some((entry) => entry.state === 'denied') && (
            <p className="muted">Blocked folders stay blocked until you allow file editing for this site in the browser's site settings.</p>
          )}
          {pending.length > 1 && (
            <div>
              <button type="button" onClick={() => void restore()} disabled={busy}>
                <Unlock size={13} aria-hidden />
                {busy ? 'asking…' : `restore all ${pending.length}`}
              </button>
            </div>
          )}
        </>
      )}
    </Panel>
  )
}
