import { NavLink, Outlet, useNavigate } from 'react-router'
import { useShortcuts } from '../keys/context'
import { SyncIndicator } from '../features/sync/SyncIndicator'
import { KeyboardProvider, ShortcutsHint } from '../keys/KeyboardProvider'

export function Layout() {
  return (
    <KeyboardProvider>
      <div className="app">
        <header className="app-header">
          <NavLink to="/" className="brand">
            <img src="/icon.svg" alt="" width={24} height={24} />
            Skelbert
          </NavLink>
          <nav>
            <NavLink to="/inbox" title="Inbox (g then i)">
              Inbox
            </NavLink>
            <NavLink to="/" end>
              Repos
            </NavLink>
            <NavLink to="/checklists">Checklists</NavLink>
            <NavLink to="/settings">Settings</NavLink>
          </nav>
          <span className="spacer" />
          <SyncIndicator />
          <ShortcutsHint />
        </header>
        <GlobalShortcuts />
        <main className="app-main">
          <Outlet />
        </main>
      </div>
    </KeyboardProvider>
  )
}

function GlobalShortcuts() {
  const navigate = useNavigate()
  useShortcuts('global', { 'nav.inbox': () => void navigate('/inbox') })
  return null
}
