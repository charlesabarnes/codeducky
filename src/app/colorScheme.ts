import type { ThemePreference } from '../db/schema'

export type Theme = 'dark' | 'light'

export const DARK_QUERY = '(prefers-color-scheme: dark)'

/** The OS dark-mode query, or null where matchMedia is missing or throws. */
export function darkQuery(): MediaQueryList | null {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null
  } catch {
    return null
  }
}

/** Only an explicit dark match counts; no preference or no way to ask means light. */
export function prefersDark(): boolean {
  return darkQuery()?.matches === true
}

export function resolveTheme(pref: ThemePreference, dark: boolean): Theme {
  if (pref === 'system') return dark ? 'dark' : 'light'
  return pref
}
