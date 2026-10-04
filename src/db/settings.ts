import type { RubberduckDb } from './db'
import { CODE_FONTS, DENSITIES, PALETTES, THEME_PREFERENCES, type Settings } from './schema'

export type LoadedSettings = Required<Settings>
export type SettingsInput = Partial<Omit<Settings, 'id'>>
export type Appearance = Pick<LoadedSettings, 'theme' | 'palette' | 'density' | 'codeFont'>
export type AppearanceKey = keyof Appearance

export const DEFAULT_APPEARANCE: Appearance = { theme: 'dark', palette: 'terminal', density: 'default', codeFont: 'plex' }
export const APPEARANCE_OPTIONS: { [K in AppearanceKey]: readonly Appearance[K][] } = {
  theme: THEME_PREFERENCES,
  palette: PALETTES,
  density: DENSITIES,
  codeFont: CODE_FONTS,
}
export const APPEARANCE_KEYS = Object.keys(APPEARANCE_OPTIONS) as AppearanceKey[]

export const defaultSettings: LoadedSettings = { id: 'app', githubPat: '', ...DEFAULT_APPEARANCE }

function optionOf<K extends AppearanceKey>(key: K, value: unknown): Appearance[K] {
  const options: readonly unknown[] = APPEARANCE_OPTIONS[key]
  return options.includes(value) ? (value as Appearance[K]) : DEFAULT_APPEARANCE[key]
}

/** Keeps the known values and falls back to the default for anything missing or unknown. */
export function appearanceOf(stored: Partial<Record<AppearanceKey, unknown>>): Appearance {
  return {
    theme: optionOf('theme', stored.theme),
    palette: optionOf('palette', stored.palette),
    density: optionOf('density', stored.density),
    codeFont: optionOf('codeFont', stored.codeFont),
  }
}

export async function loadSettings(db: RubberduckDb): Promise<LoadedSettings> {
  const stored = await db.settings.get('app')
  return stored ? { id: 'app', githubPat: stored.githubPat ?? '', ...appearanceOf(stored) } : defaultSettings
}

/** Saves the given fields and keeps the others. */
export async function saveSettings(db: RubberduckDb, input: SettingsInput): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const current = await loadSettings(db)
    await db.settings.put({
      id: 'app',
      githubPat: (input.githubPat ?? current.githubPat).trim(),
      theme: input.theme ?? current.theme,
      palette: input.palette ?? current.palette,
      density: input.density ?? current.density,
      codeFont: input.codeFont ?? current.codeFont,
    })
  })
}
