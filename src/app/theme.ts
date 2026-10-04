import { db } from '../db/db'
import type { ThemePreference } from '../db/schema'
import { DEFAULT_THEME, loadSettings } from '../db/settings'

export type Theme = 'dark' | 'light'

/** Mirrors the stored preference so the first paint already uses it; IndexedDB answers too late for that. */
const CACHE_KEY = 'skelbert.theme'
const LIGHT_QUERY = '(prefers-color-scheme: light)'
const THEME_COLORS: Record<Theme, string> = { dark: '#0f0d0a', light: '#f7f5ef' }

let preference: ThemePreference = DEFAULT_THEME
let chosenThisSession = false

export function resolveTheme(pref: ThemePreference, prefersLight: boolean): Theme {
  if (pref === 'system') return prefersLight ? 'light' : 'dark'
  return pref
}

function render() {
  const theme = resolveTheme(preference, window.matchMedia(LIGHT_QUERY).matches)
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme])
}

export function applyTheme(next: ThemePreference) {
  chosenThisSession = true
  preference = next
  localStorage.setItem(CACHE_KEY, next)
  render()
}

/** Applies the cached theme now, then the stored one, and follows the OS while the preference is system. */
export function startTheme() {
  const cached = localStorage.getItem(CACHE_KEY)
  if (cached === 'dark' || cached === 'light' || cached === 'system') preference = cached
  render()
  window.matchMedia(LIGHT_QUERY).addEventListener('change', () => preference === 'system' && render())
  loadSettings(db)
    .then(({ theme }) => {
      if (!chosenThisSession) applyTheme(theme)
    })
    .catch((error: unknown) => console.error('Could not load the theme', error))
}
