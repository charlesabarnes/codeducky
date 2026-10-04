import { useState } from 'react'
import { readStorage, writeStorage } from '../../app/storage'
import type { ViewMode } from '../../diff/DiffTable'
import type { FileOrder } from '../../review/order'

const KEYS = {
  mode: 'rubberduck.viewMode',
  ignoreWhitespace: 'rubberduck.ignoreWhitespace',
  order: 'rubberduck.fileOrder',
} as const

/** A preference kept in localStorage on this device, or only in memory when storage fails. */
function usePersisted<T>(key: string, read: (stored: string | null) => T, write: (value: T) => string) {
  const [value, setValue] = useState<T>(() => read(readStorage(key)))
  const change = (next: T) => {
    setValue(next)
    writeStorage(key, write(next))
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
