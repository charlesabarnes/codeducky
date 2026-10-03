import { NavLink, Outlet } from 'react-router'
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
        <main className="app-main">
          <Outlet />
        </main>
      </div>
    </KeyboardProvider>
  )
}
