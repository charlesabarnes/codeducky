import { FolderGit2, Inbox, ListChecks, Settings2 } from 'lucide-react'
import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router'
import { useKeys, useShortcuts } from '../keys/context'
import { AccountChip } from '../features/sync/AccountChip'
import { AccountSwitchDialog } from '../features/sync/AccountSwitchDialog'
import { SyncIndicator } from '../features/sync/SyncIndicator'
import { KeyboardProvider, ShortcutsHint } from '../keys/KeyboardProvider'
import { ChromeContext } from './chromeContext'

export function Layout() {
  const [crumbs, setCrumbs] = useState<HTMLElement | null>(null)
  const [status, setStatus] = useState<HTMLElement | null>(null)
  return (
    <KeyboardProvider>
      <ChromeContext.Provider value={{ crumbs, status }}>
        <div className="app">
          <header className="app-header">
            <NavLink to="/" className="brand">
              <img className="brand-mark" src="/codeducky.svg" alt="" width="20" height="20" />
              code ducky
            </NavLink>
            <nav>
              <NavLink to="/inbox" title="Inbox (g then i)">
                <Inbox size={13} aria-hidden />
                inbox
              </NavLink>
              <NavLink to="/" end>
                <FolderGit2 size={13} aria-hidden />
                repos
              </NavLink>
              <NavLink to="/checklists">
                <ListChecks size={13} aria-hidden />
                checklists
              </NavLink>
              <NavLink to="/settings">
                <Settings2 size={13} aria-hidden />
                settings
              </NavLink>
            </nav>
            <div className="crumbs" ref={setCrumbs} />
            <span className="spacer" />
            <SyncIndicator />
            <AccountChip />
            <ShortcutsHint />
          </header>
          <GlobalShortcuts />
          <AccountSwitchDialog />
          <main className="app-main">
            <Outlet />
          </main>
          <footer className="status-bar">
            <div className="status-slot" ref={setStatus} />
            <HelpHint />
          </footer>
        </div>
      </ChromeContext.Provider>
    </KeyboardProvider>
  )
}

function HelpHint() {
  const { openHelp } = useKeys()
  return (
    <button type="button" className="link status-help hint" onClick={openHelp}>
      <b>?</b> help
    </button>
  )
}

function GlobalShortcuts() {
  const navigate = useNavigate()
  useShortcuts('global', { 'nav.inbox': () => void navigate('/inbox') })
  return null
}
