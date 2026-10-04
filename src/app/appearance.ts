import { db } from '../db/db'
import type { CodeFont, Palette, ThemePreference } from '../db/schema'
import { APPEARANCE_KEYS, DEFAULT_APPEARANCE, appearanceOf, loadSettings, type Appearance, type AppearanceKey } from '../db/settings'

export type Theme = 'dark' | 'light'

/** Mirrors the stored settings so the first paint already uses them; IndexedDB answers too late for that. */
const CACHE_KEYS: Record<AppearanceKey, string> = {
  theme: 'skelbert.theme',
  palette: 'skelbert.palette',
  density: 'skelbert.density',
  codeFont: 'skelbert.codeFont',
}
const LIGHT_QUERY = '(prefers-color-scheme: light)'
/** Each palette's --bg, for the browser's title bar. */
const THEME_COLORS: Record<Palette, Record<Theme, string>> = {
  terminal: { dark: '#0f0d0a', light: '#f7f5ef' },
  fjord: { dark: '#1c222b', light: '#f2f5f9' },
  solar: { dark: '#002c37', light: '#fcf5e3' },
  dusk: { dark: '#151423', light: '#f5f4fc' },
  contrast: { dark: '#060606', light: '#ffffff' },
}
/** Code fonts beyond the UI's Plex Mono, fetched the first time they are picked. */
const FONT_LOADERS: Partial<Record<CodeFont, () => Promise<unknown>>> = {
  jetbrains: () =>
    Promise.all([import('@fontsource/jetbrains-mono/latin-400.css'), import('@fontsource/jetbrains-mono/latin-700.css')]),
}

let current: Appearance = DEFAULT_APPEARANCE
const loadedFonts = new Set<CodeFont>()
/** Settings picked while the startup load was pending, which it must not overwrite. */
const chosen = new Set<AppearanceKey>()

export function resolveTheme(pref: ThemePreference, prefersLight: boolean): Theme {
  if (pref === 'system') return prefersLight ? 'light' : 'dark'
  return pref
}

function loadCodeFont(font: CodeFont) {
  const load = FONT_LOADERS[font]
  if (!load || loadedFonts.has(font)) return
  loadedFonts.add(font)
  load().catch((error: unknown) => console.error('Could not load the code font', error))
}

function render() {
  const theme = resolveTheme(current.theme, window.matchMedia(LIGHT_QUERY).matches)
  const root = document.documentElement
  root.dataset.theme = theme
  root.dataset.palette = current.palette
  root.dataset.density = current.density
  root.dataset.codeFont = current.codeFont
  loadCodeFont(current.codeFont)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[current.palette][theme])
}

export function applyAppearance(next: Partial<Appearance>) {
  for (const key of Object.keys(next) as AppearanceKey[]) chosen.add(key)
  current = { ...current, ...next }
  for (const key of APPEARANCE_KEYS) localStorage.setItem(CACHE_KEYS[key], current[key])
  render()
}

/** Applies the cached appearance now, then the stored one, and follows the OS while the theme is system. */
export function startAppearance() {
  current = appearanceOf(Object.fromEntries(APPEARANCE_KEYS.map((key) => [key, localStorage.getItem(CACHE_KEYS[key])])))
  render()
  window.matchMedia(LIGHT_QUERY).addEventListener('change', () => current.theme === 'system' && render())
  loadSettings(db)
    .then((settings) => {
      const stored: Partial<Appearance> = appearanceOf(settings)
      for (const key of chosen) delete stored[key]
      applyAppearance(stored)
    })
    .catch((error: unknown) => console.error('Could not load the appearance settings', error))
}
