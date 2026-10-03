import { createContext, useContext, useEffect, useRef } from 'react'
import type { ShortcutDispatcher } from './dispatcher'
import type { KeyScope, ShortcutId } from './keymap'

export interface KeysApi {
  dispatcher: ShortcutDispatcher
  /** Reads a message to screen readers (polite live region); visible ones also show briefly on screen. */
  announce: (message: string, options?: { visible?: boolean }) => void
  openHelp: () => void
}

export const KeysContext = createContext<KeysApi | null>(null)

export function useKeys(): KeysApi {
  const api = useContext(KeysContext)
  if (!api) throw new Error('useKeys needs a KeyboardProvider')
  return api
}

/** Return false to let the key fall through to a lower scope or the browser. */
export type ShortcutHandlers = Partial<Record<ShortcutId, () => boolean | void>>

/**
 * Attaches handlers to shortcut ids for as long as the component is mounted (and enabled).
 * Handlers may change every render; registration only changes when the set of ids does.
 */
export function useShortcuts(scope: KeyScope, handlers: ShortcutHandlers, enabled = true): void {
  const { dispatcher } = useKeys()
  const latest = useRef(handlers)
  useEffect(() => {
    latest.current = handlers
  })
  const ids = Object.keys(handlers).sort().join(' ')
  useEffect(() => {
    if (!enabled || !ids) return
    return dispatcher.register(scope, ids.split(' '), (id) => latest.current[id as ShortcutId]?.())
  }, [dispatcher, scope, ids, enabled])
}
