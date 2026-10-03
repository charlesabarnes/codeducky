import { useEffect, useState, useSyncExternalStore } from 'react'
import { highlightLines, type ColorScheme, type LineTokens } from './highlight'

const DARK_QUERY = '(prefers-color-scheme: dark)'

function subscribe(onChange: () => void) {
  const media = window.matchMedia(DARK_QUERY)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribe, () => (window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'))
}

export interface SideTokens {
  old: LineTokens | null
  new: LineTokens | null
}

const EMPTY: SideTokens = { old: null, new: null }

export function useHighlight(path: string, oldText: string, newText: string): SideTokens {
  const scheme = useColorScheme()
  const [result, setResult] = useState<{ key: string; tokens: SideTokens } | null>(null)
  const key = `${scheme}\u0000${path}\u0000${oldText}\u0000${newText}`

  useEffect(() => {
    let cancelled = false
    Promise.all([
      oldText ? highlightLines(oldText, path, scheme) : null,
      newText ? highlightLines(newText, path, scheme) : null,
    ])
      .then(([oldTokens, newTokens]) => {
        if (!cancelled) setResult({ key, tokens: { old: oldTokens, new: newTokens } })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [key, path, oldText, newText, scheme])

  return result?.key === key ? result.tokens : EMPTY
}
