import { useEffect, useState } from 'react'
import { highlightLines, type LineTokens } from './highlight'

export interface SideTokens {
  old: LineTokens | null
  new: LineTokens | null
}

const EMPTY: SideTokens = { old: null, new: null }

export function useHighlight(path: string, oldText: string, newText: string): SideTokens {
  const [result, setResult] = useState<{ key: string; tokens: SideTokens } | null>(null)
  const key = `${path}\u0000${oldText}\u0000${newText}`

  useEffect(() => {
    let cancelled = false
    Promise.all([oldText ? highlightLines(oldText, path) : null, newText ? highlightLines(newText, path) : null])
      .then(([oldTokens, newTokens]) => {
        if (!cancelled) setResult({ key, tokens: { old: oldTokens, new: newTokens } })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [key, path, oldText, newText])

  return result?.key === key ? result.tokens : EMPTY
}
