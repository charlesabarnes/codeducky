import { Lock, Unlock } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Panel } from '../../ui/Panel'
import { hasReadPermission, requestReadPermission } from '../../fs/permission'

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

  const request = async () => setState((await requestReadPermission(handle)) ? 'granted' : 'denied')

  return (
    <div className="page narrow stack">
      <Panel icon={Lock} title="folder access">
      <p>
        Skelbert needs read access to <strong>{handle.name}</strong> again. Browsers ask each time the app is reopened.
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
