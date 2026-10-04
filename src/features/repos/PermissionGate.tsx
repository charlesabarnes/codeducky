import { Lock, Unlock } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Panel } from '../../ui/Panel'
import { hasReadPermission, requestReadPermission } from '../../fs/permission'
import { folderAccess } from '../../pwa/client'
import { AccessDurationNote } from '../pwa/FolderAccess'

type State = 'checking' | 'granted' | 'prompt' | 'denied'

interface PermissionGateProps {
  handle: FileSystemDirectoryHandle
  children: ReactNode
}

export function PermissionGate({ handle, children }: PermissionGateProps) {
  const [state, setState] = useState<State>('checking')

  useEffect(() => {
    let cancelled = false
    hasReadPermission(handle).then((granted) => {
      if (!cancelled) setState(granted ? 'granted' : 'prompt')
    })
    return () => {
      cancelled = true
    }
  }, [handle])

  if (state === 'granted') return children
  if (state === 'checking') return <p className="page muted">Checking folder access…</p>

  const request = async () => {
    const granted = await requestReadPermission(handle)
    setState(granted ? 'granted' : 'denied')
    if (granted) folderAccess.refresh().catch((error: unknown) => console.warn('Could not check folder access', error))
  }

  return (
    <div className="page narrow stack">
      <Panel icon={Lock} title="folder access">
      <p>
        Code Ducky needs read access to <strong>{handle.name}</strong> again. <AccessDurationNote />
      </p>
      {state === 'denied' && <p className="error">Access was not granted.</p>}
      <div>
        <button type="button" onClick={request}>
          <Unlock size={13} aria-hidden />
          allow read access
        </button>
      </div>
      </Panel>
    </div>
  )
}
