import { useState } from 'react'
import type { ViewMode } from '../../diff/DiffTable'
import type { FileOrder } from '../../review/order'

const KEYS = {
  mode: 'skelbert.viewMode',
  ignoreWhitespace: 'skelbert.ignoreWhitespace',
  order: 'skelbert.fileOrder',
} as const

/** A preference kept in localStorage on this device. */
function usePersisted<T>(key: string, read: (stored: string | null) => T, write: (value: T) => string) {
  const [value, setValue] = useState<T>(() => read(localStorage.getItem(key)))
  const change = (next: T) => {
    setValue(next)
    localStorage.setItem(key, write(next))
  }
  return [value, change] as const
}

/** How diffs are laid out and files ordered, remembered across sessions. */
export function useViewPrefs() {
  const [mode, setMode] = usePersisted<ViewMode>(KEYS.mode, (s) => (s === 'split' ? 'split' : 'unified'), String)
  const [ignoreWhitespace, setIgnoreWhitespace] = usePersisted(KEYS.ignoreWhitespace, (s) => s === 'on', (v) => (v ? 'on' : 'off'))
  const [order, setOrder] = usePersisted<FileOrder>(KEYS.order, (s) => (s === 'risk' ? 'risk' : 'folders'), String)
  return { mode, setMode, ignoreWhitespace, setIgnoreWhitespace, order, setOrder }
}
