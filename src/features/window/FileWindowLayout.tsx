import { useState } from 'react'
import { Outlet } from 'react-router'
import { ChromeContext } from '../../app/chromeContext'
import { KeyboardProvider, ShortcutsHint } from '../../keys/KeyboardProvider'
import { UpdateBanner } from '../pwa/UpdateBanner'
import './window.css'

/** The shell of a file window: the app's header and status bar, without its navigation or the session sidebar. */
export function FileWindowLayout() {
  const [crumbs, setCrumbs] = useState<HTMLElement | null>(null)
  const [status, setStatus] = useState<HTMLElement | null>(null)
  return (
    <KeyboardProvider>
      <ChromeContext.Provider value={{ crumbs, status }}>
        <div className="app">
          <header className="app-header">
            <span className="brand">
              <img className="brand-mark" src="/codeducky.svg" alt="" width="20" height="20" />
              code ducky
            </span>
            <div className="crumbs" ref={setCrumbs} />
            <span className="spacer" />
            <ShortcutsHint />
          </header>
          <UpdateBanner />
          <main className="app-main">
            <Outlet />
          </main>
          <footer className="status-bar">
            <div className="status-slot" ref={setStatus} />
          </footer>
        </div>
      </ChromeContext.Provider>
    </KeyboardProvider>
  )
}
