import { ChevronDown, LogOut, Settings2, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useSyncState } from '../../sync/client'
import { signOutKeepingData, signOutRemovingData } from './accountActions'
import { Avatar } from './Avatar'
import './sync.css'

/** The signed-in account in the header, with a menu for Settings and signing out. */
export function AccountChip() {
  const { auth, user } = useSyncState()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => !root.current?.contains(event.target as Node) && setOpen(false)
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (auth !== 'signedIn' || !user) return null
  const close = () => setOpen(false)

  return (
    <div className="account-chip" ref={root}>
      <button
        type="button"
        className="link header-item account-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={user.name ?? user.login}
      >
        <Avatar user={user} />
        <span>@{user.login}</span>
        {user.role === 'admin' && <span className="badge admin-badge">admin</span>}
        <ChevronDown size={12} aria-hidden />
      </button>
      {open && (
        <div className="account-menu" role="menu">
          <div className="account-menu-head">
            <Avatar user={user} size={28} />
            <span className="stack-tight">
              <strong>{user.name ?? `@${user.login}`}</strong>
              {user.name && <span className="muted">@{user.login}</span>}
            </span>
          </div>
          <Link to="/settings#sync" role="menuitem" onClick={close}>
            <Settings2 size={13} aria-hidden />
            settings
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close()
              signOutKeepingData()
            }}
          >
            <LogOut size={13} aria-hidden />
            sign out
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              close()
              void signOutRemovingData()
            }}
          >
            <Trash2 size={13} aria-hidden />
            sign out and remove data
          </button>
        </div>
      )}
    </div>
  )
}
