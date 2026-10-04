import type { SkelbertDb } from './db'
import { THEME_PREFERENCES, type Settings, type ThemePreference } from './schema'

export type LoadedSettings = Required<Settings>
export type SettingsInput = Partial<Omit<Settings, 'id'>>

export const DEFAULT_THEME: ThemePreference = 'dark'

export const defaultSettings: LoadedSettings = { id: 'app', githubPat: '', theme: DEFAULT_THEME }

const themeOf = (value: unknown): ThemePreference =>
  THEME_PREFERENCES.includes(value as ThemePreference) ? (value as ThemePreference) : DEFAULT_THEME

export async function loadSettings(db: SkelbertDb): Promise<LoadedSettings> {
  const stored = await db.settings.get('app')
  return stored ? { id: 'app', githubPat: stored.githubPat ?? '', theme: themeOf(stored.theme) } : defaultSettings
}

/** Saves the given fields and keeps the others. */
export async function saveSettings(db: SkelbertDb, input: SettingsInput): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const current = await loadSettings(db)
    await db.settings.put({
      id: 'app',
      githubPat: (input.githubPat ?? current.githubPat).trim(),
      theme: input.theme ?? current.theme,
    })
  })
}
