import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { KeysContext, useKeys, type KeysApi } from './context'
import { ShortcutDispatcher } from './dispatcher'
import { HelpOverlay } from './HelpOverlay'
import { eventToken, isEditableTarget } from './tokens'
import './keys.css'

const ENABLED_KEY = 'skelbert.shortcuts'
const TOAST_MS = 2500

function modalOpen(): boolean {
  try {
    return document.querySelector('dialog:modal') !== null
  } catch {
    return false
  }
}

function blurField(): boolean {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !isEditableTarget(active)) return false
  active.blur()
  return true
}

interface Message {
  text: string
  visible: boolean
  at: number
}

export function KeyboardProvider({ children }: { children: ReactNode }) {
  const [dispatcher] = useState(() => new ShortcutDispatcher())
  const [enabled, setEnabled] = useState(() => localStorage.getItem(ENABLED_KEY) !== 'off')
  const [help, setHelp] = useState<ReadonlySet<string> | null>(null)
  const [message, setMessage] = useState<Message | null>(null)

  const announce = useCallback((text: string, options?: { visible?: boolean }) => {
    // Alternate a trailing space so repeating the same message is announced again.
    setMessage((current) => ({
      text: current?.text === text ? `${text}\u00a0` : text,
      visible: options?.visible ?? false,
      at: Date.now(),
    }))
  }, [])
  const openHelp = useCallback(() => setHelp(dispatcher.activeIds()), [dispatcher])
  const changeEnabled = (next: boolean) => {
    setEnabled(next)
    localStorage.setItem(ENABLED_KEY, next ? 'on' : 'off')
  }

  useEffect(() => {
    dispatcher.setEnabled(enabled)
  }, [dispatcher, enabled])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || modalOpen()) return
      const handled = dispatcher.handle({
        token: eventToken(event),
        editable: isEditableTarget(event.target),
        repeat: event.repeat,
        now: performance.now(),
      })
      if (handled) event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    const unregister = dispatcher.register('global', ['help', 'escape'], (id) => (id === 'help' ? openHelp() : blurField()))
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      unregister()
    }
  }, [dispatcher, openHelp])

  const toast = message?.visible ? message : null
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setMessage((current) => (current === toast ? { ...current, visible: false } : current)), TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast])

  const api = useMemo<KeysApi>(() => ({ dispatcher, announce, openHelp }), [dispatcher, announce, openHelp])

  return (
    <KeysContext.Provider value={api}>
      {children}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {message?.text}
      </div>
      {toast && (
        <div className="keys-toast" aria-hidden="true">
          {toast.text}
        </div>
      )}
      {help && (
        <HelpOverlay active={help} enabled={enabled} onEnabledChange={changeEnabled} onClose={() => setHelp(null)} />
      )}
    </KeysContext.Provider>
  )
}

/** The subtle "?" hint in the header; also the way back in when single-key shortcuts are off. */
export function ShortcutsHint() {
  const { openHelp } = useKeys()
  return (
    <button type="button" className="keys-hint" onClick={openHelp} aria-keyshortcuts="?" title="Keyboard shortcuts">
      <kbd>?</kbd> Shortcuts
    </button>
  )
}
