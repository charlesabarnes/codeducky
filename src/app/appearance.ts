import { db } from '../db/db'
import type { CodeFont, Palette } from '../db/schema'
import { APPEARANCE_KEYS, DEFAULT_APPEARANCE, appearanceOf, loadSettings, type Appearance, type AppearanceKey } from '../db/settings'
import { darkQuery, prefersDark, resolveTheme, type Theme } from './colorScheme'
import { readStorage, writeStorage } from './storage'

/** Mirrors the stored settings so the first paint already uses them; IndexedDB answers too late for that. */
const CACHE_KEYS: Record<AppearanceKey, string> = {
  theme: 'rubberduck.theme',
  palette: 'rubberduck.palette',
  density: 'rubberduck.density',
  codeFont: 'rubberduck.codeFont',
}
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

/** The cache is only a first-paint hint, so stop at the first failed write rather than warn for every key. */
function writeCache() {
  APPEARANCE_KEYS.every((key) => writeStorage(CACHE_KEYS[key], current[key]))
}

function loadCodeFont(font: CodeFont) {
  const load = FONT_LOADERS[font]
  if (!load || loadedFonts.has(font)) return
  loadedFonts.add(font)
  load().catch((error: unknown) => console.error('Could not load the code font', error))
}

function render() {
  const theme = resolveTheme(current.theme, prefersDark())
  const root = document.documentElement
  root.dataset.theme = theme
  root.dataset.palette = current.palette
  root.dataset.density = current.density
  root.dataset.codeFont = current.codeFont
  loadCodeFont(current.codeFont)
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', THEME_COLORS[current.palette][theme])
}

export function applyAppearance(next: Partial<Appearance>) {
  for (const key of Object.keys(next) as AppearanceKey[]) chosen.add(key)
  current = { ...current, ...next }
  writeCache()
  render()
}

/** Applies the cached appearance now, then the stored one, and follows the OS while the theme is system. */
export function startAppearance() {
  current = appearanceOf(Object.fromEntries(APPEARANCE_KEYS.map((key) => [key, readStorage(CACHE_KEYS[key])])))
  render()
  darkQuery()?.addEventListener('change', () => current.theme === 'system' && render())
  loadSettings(db)
    .then((settings) => {
      const stored: Partial<Appearance> = appearanceOf(settings)
      for (const key of chosen) delete stored[key]
      applyAppearance(stored)
    })
    .catch((error: unknown) => console.error('Could not load the appearance settings', error))
}
